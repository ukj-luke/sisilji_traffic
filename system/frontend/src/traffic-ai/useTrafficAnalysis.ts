import { useEffect, useState, type RefObject } from 'react'
import { registeredLanes, type LaneProfile } from './lane-profiles'
import { acquireDetector, type Detection } from './detector'
import { signOccluder } from './landmarks'
import { movingRegions } from './moving-region'
import { FrameFollower, grayscale } from './follow'
import {
  LaneMotion,
  measure,
  inLane,
  windowPercent,
  type Box,
  type Sample,
  type VehicleMotion,
} from './metrics'

export type FrameResult = {
  profile: LaneProfile
  boxes: Box[]
  rearReadable?: boolean
  rearCount?: number
  motionById?: VehicleMotion
  slow: number[]
  observed: number[]
  counts: number[]
  readable: boolean[]
  percentages: (number | null)[]
  visible: boolean
}
export function useTrafficAnalysis(
  host: RefObject<HTMLDivElement | null>,
  camera: string,
  enabled: boolean,
  profile: LaneProfile,
  retry: number,
) {
  const [frame, setFrame] = useState<FrameResult | null>(null)
  const [status, setStatus] = useState('')
  const [overlay, setOverlay] = useState<{
    camera: string
    profile: LaneProfile
    boxes: Box[]
  } | null>(null)
  useEffect(() => {
    setFrame(null)
    setOverlay(null)
    if (!enabled) return
    let lease: ReturnType<typeof acquireDetector>
    try {
      lease = acquireDetector()
    } catch {
      setStatus('이 브라우저에서 분석을 시작할 수 없어요.')
      return
    }
    const detector = lease.detector
    const large = document.createElement('canvas'),
      small = document.createElement('canvas')
    const rgb = large.getContext('2d', { willReadFrequently: true }),
      gray = small.getContext('2d', { willReadFrequently: true })
    const { trackingAreas, trackVehicles = false } = registeredLanes(camera)
    const follower = new FrameFollower(trackVehicles, signOccluder(camera))
    const areas = profile.rearApproach
      ? [...profile.lanes, profile.rearApproach]
      : profile.lanes
    function inObservedArea(boxes: Box[]) {
      if (camera !== 'gits-6590') return boxes
      return boxes.filter((b) =>
        areas.some((lane) => inLane(b.x + b.w / 2, b.y + b.h * 0.94, lane)),
      )
    }
    const roads = [...areas, ...(trackingAreas ?? [])]
    let closed = false,
      ready = false,
      failed = false,
      generation = 0
    let video: HTMLVideoElement | null = null,
      callback: number | undefined
    let trackingMs = 0
    let lastTime = -1,
      lastDecoded = 0,
      waiting = true
    let history: Sample[] = [],
      motion = new LaneMotion()
    let rearSample: { time: number; count: number } | undefined
    let discontinuity = false
    let capturedFrames = -1
    let quality:
      | { readable: boolean[]; rearReadable?: boolean; time: number }
      | undefined
    let lastSample = -Infinity
    function sampleTracks(time: number) {
      if (quality && time - quality.time > 1.25) {
        quality = undefined
        history = []
        motion = new LaneMotion()
        setFrame(null)
      }
      if (!quality || time - lastSample < 0.2 || !video?.videoHeight) return
      lastSample = time
      const boxes = inObservedArea(follower.observedVehicles)
      const aspect = video.videoWidth / video.videoHeight
      const { counts, occupancy, assignments } = measure(
        areas,
        boxes,
        aspect,
        profile.widthReferences,
      )
      const { readable, rearReadable } = quality
      const flow = motion.update(
        boxes,
        assignments.map((i) => (readable[i] ? i : -1)),
        time,
        aspect,
        areas.length,
      )
      history = history.filter((s) => s.time >= time - 5)
      history.push({
        time,
        occupancy: occupancy.map((v, i) => (readable[i] ? v : null)),
      })
      setFrame({
        profile,
        boxes,
        counts,
        ...flow,
        readable,
        rearReadable,
        rearCount: profile.rearApproach
          ? counts[profile.lanes.length]
          : undefined,
        percentages: areas.map((_, i) => windowPercent(history, i)),
        visible: true,
      })
    }
    function clearReadings() {
      rearSample = undefined
      quality = undefined
      lastSample = -Infinity
      generation++
      lastTime = -1
      history = []
      motion = new LaneMotion()
      setFrame(null)
    }
    function reset() {
      clearReadings()
      follower.reset()
      setOverlay(null)
    }
    function suspend(event?: Event) {
      if (!waiting) {
        if (trackVehicles) {
          clearReadings()
          discontinuity = true
        } else reset()
      }
      if (
        event?.type === 'seeking' ||
        event?.type === 'emptied' ||
        video?.seeking ||
        !video ||
        video.readyState === 0 ||
        document.hidden
      )
        setOverlay(null)
      waiting = true
      setStatus(
        video?.paused && !video.ended
          ? '영상 일시정지'
          : '영상 프레임을 기다리는 중이에요.',
      )
    }
    function fail(message: string) {
      if (!closed) {
        failed = true
        reset()
        setStatus(message)
      }
    }

    function capture(time: number, presentationOnly = false) {
      if (closed || !ready || failed || !rgb || !gray || !video) return
      if (
        document.hidden ||
        video.readyState < 2 ||
        (!presentationOnly && video.paused) ||
        video.ended ||
        video.seeking
      ) {
        suspend()
        return
      }
      // 폴백으로 읽은 재생 시각이 지연된 디코더 콜백보다 조금 앞설 수 있습니다.
      if (
        lastTime >= 0 &&
        time < lastTime &&
        lastTime - time < 0.35 &&
        !discontinuity
      )
        return
      if (lastTime >= 0 && (time < lastTime || time - lastTime > 1.25)) {
        if (trackVehicles) discontinuity = true
        else reset()
      }
      const interval = trackVehicles
        ? Math.max(1 / 32, Math.min(0.12, (3 * trackingMs) / 1000))
        : 1 / 18
      if (lastTime >= 0 && time - lastTime < interval) return
      waiting = false
      lastDecoded = performance.now()
      lastTime = time
      capturedFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1
      const width = video.videoWidth,
        height = video.videoHeight
      function size(canvas: HTMLCanvasElement, max: number) {
        const scale = Math.min(1, max / Math.max(width, height))
        const w = Math.max(1, Math.round(width * scale)),
          h = Math.max(1, Math.round(height * scale))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
      }
      try {
        const start = performance.now()
        size(small, profile.rearApproach || trackVehicles ? 512 : 384)
        gray.drawImage(video, 0, 0, small.width, small.height)
        const cut = follower.push(
          grayscale(time, gray.getImageData(0, 0, small.width, small.height)),
          discontinuity,
        )
        discontinuity = false
        trackingMs = trackingMs * 0.7 + (performance.now() - start) * 0.3
        if (cut) {
          quality = undefined
          lastSample = -Infinity
          rearSample = undefined
          generation++
          history = []
          motion = new LaneMotion()
          setFrame(null)
        }
        const displayBoxes = inObservedArea(follower.visible)
        setOverlay({ camera, profile, boxes: displayBoxes })
        if (trackVehicles && !presentationOnly) sampleTracks(time)
        if (presentationOnly || detector.busy) return
        size(large, 832)
        rgb.drawImage(video, 0, 0, large.width, large.height)
        const pixels = rgb.getImageData(0, 0, large.width, large.height).data
        const stamp = generation,
          source = video
        function publish(data: Detection) {
          if (
            closed ||
            failed ||
            stamp !== generation ||
            source !==
              host.current?.querySelector<HTMLVideoElement>(
                'video:not([hidden])',
              ) ||
            document.hidden ||
            source.paused ||
            source.seeking ||
            source.readyState < 2 ||
            !follower.has(time)
          )
            return
          const complete = data.type === 'frame'
          const visible = data.visible
          const brightEnough =
            profile.minMedian === undefined ||
            data.signature.slice().sort()[140] >= profile.minMedian
          const readable = brightEnough
            ? data.readable
            : data.readable.map(() => false)
          const { lanes, rearApproach: rear } = profile
          if (!visible) {
            quality = undefined
            lastSample = -Infinity
            follower.reset()
            setOverlay(null)
            history = []
            motion = new LaneMotion()
            rearSample = undefined
          }
          const boxes = visible
            ? follower.observe(
                data.boxes,
                time,
                complete,
                !!rear,
                !!data.rearScanned,
              )
            : []
          if (visible) {
            setOverlay({
              camera,
              profile,
              boxes: inObservedArea(follower.visible),
            })
            if (trackVehicles) {
              const rearReadable = brightEnough && data.rearReadable
              quality = {
                readable: rear ? [...readable, !!rearReadable] : readable,
                rearReadable,
                time,
              }
              sampleTracks(lastTime)
              setStatus('')
              return
            }
          }
          const { counts, occupancy, assignments } = measure(
            lanes,
            boxes,
            width / height,
            profile.widthReferences,
          )
          if (!rear || (rearSample && time - rearSample.time > 1))
            rearSample = undefined
          if (rear && visible && complete) {
            const count = boxes.filter(
              (b, i) =>
                assignments[i] < 0 &&
                inLane(b.x + b.w / 2, b.y + b.h * 0.94, rear),
            ).length
            if (data.rearScanned || (!rearSample && count > 0))
              rearSample = { time, count }
          }
          const rearCount = rearSample?.count
          const flow = complete
            ? motion.update(
                boxes,
                assignments.map((i) => (readable[i] ? i : -1)),
                time,
                width / height,
                lanes.length,
              )
            : { slow: lanes.map(() => 0), observed: lanes.map(() => 0) }
          if (complete && visible) {
            history = history.filter((s) => s.time >= time - 5)
            history.push({
              time,
              occupancy: occupancy.map((v, i) => (readable[i] ? v : null)),
            })
          }
          setFrame((prev) =>
            !complete &&
            prev &&
            prev.profile === profile &&
            prev.visible === visible
              ? prev
              : {
                  profile,
                  boxes,
                  rearReadable: data.rearReadable,
                  rearCount,
                  counts,
                  ...flow,
                  readable,
                  percentages: lanes.map((_, i) => windowPercent(history, i)),
                  visible,
                },
          )
          setStatus('')
        }
        void detector
          .run(
            {
              camera,
              rearApproach: profile.rearApproach,
              detailRegions: profile.detailRegions,
              trackingAreas,
              trackedBoxes: trackVehicles
                ? follower.continuationBoxes
                : undefined,
              movingTarget: follower.searchTarget(
                time,
                (now, recent, earlier) =>
                  movingRegions(now, recent, earlier).filter((b) =>
                    roads.some((lane) =>
                      inLane(b.x + b.w / 2, b.y + b.h * 0.94, lane),
                    ),
                  ),
              ),
              directions: profile.labels?.map((label) => label.direction),
              pixels,
              width: large.width,
              height: large.height,
              lanes: profile.lanes,
            },
            publish,
          )
          .then(publish)
          .catch(() =>
            fail('분석 모델을 실행하지 못했어요. 다시 시도해 주세요.'),
          )
      } catch {
        fail('이 영상의 프레임을 읽을 수 없어요. 분석을 다시 켜 주세요.')
      }
    }

    function nextFrame() {
      if (!video?.requestVideoFrameCallback || closed || failed) return
      const source = video
      callback = source.requestVideoFrameCallback((_, meta) => {
        if (closed || source !== video) return
        capture(meta.mediaTime)
        nextFrame()
      })
    }
    function detach() {
      if (callback !== undefined) video?.cancelVideoFrameCallback?.(callback)
      callback = undefined
      for (const event of ['pause', 'seeking', 'emptied', 'ended'])
        video?.removeEventListener(event, suspend)
    }
    function inspect() {
      if (closed || failed || !ready) return
      const current =
        host.current?.querySelector<HTMLVideoElement>('video:not([hidden])') ??
        null
      if (current !== video) {
        detach()
        if (trackVehicles && video && current) {
          clearReadings()
          discontinuity = true
          waiting = true
          if (current.readyState < 2 || current.seeking) setOverlay(null)
        } else reset()
        capturedFrames = -1
        video = current
        lastDecoded = performance.now()
        for (const event of ['pause', 'seeking', 'emptied', 'ended'])
          video?.addEventListener(event, suspend)
        if (trackVehicles && video && video.readyState >= 2 && !video.seeking)
          capture(video.currentTime, true)
        nextFrame()
      }
      if (
        !video ||
        document.hidden ||
        video.paused ||
        video.readyState < 2 ||
        video.seeking
      ) {
        suspend()
        return
      }
      const stalledCallback =
        trackVehicles &&
        performance.now() - lastDecoded > 160 &&
        (video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1) >
          capturedFrames
      if (
        typeof video.requestVideoFrameCallback !== 'function' ||
        stalledCallback
      )
        capture(video.currentTime)
      if (!waiting && performance.now() - lastDecoded > 1000) suspend()
    }
    setStatus('차량 감지 모델을 준비하고 있어요.')
    void detector.ready
      .then(() => {
        if (closed) return
        if (!rgb || !gray) {
          fail('이 브라우저에서 영상 프레임을 읽을 수 없어요.')
          return
        }
        ready = true
        setStatus('첫 영상 프레임을 분석하고 있어요.')
        inspect()
      })
      .catch(() => fail('분석 모델을 실행하지 못했어요. 다시 시도해 주세요.'))
    const container = host.current
    container?.addEventListener('playing', inspect, true)
    const timer = window.setInterval(inspect, 75)
    document.addEventListener('visibilitychange', inspect)
    return () => {
      closed = true
      detach()
      clearInterval(timer)
      container?.removeEventListener('playing', inspect, true)
      document.removeEventListener('visibilitychange', inspect)
      lease.release()
    }
  }, [host, camera, enabled, profile, retry])
  return {
    frame,
    status,
    displayBoxes:
      overlay?.camera === camera && overlay.profile === profile
        ? overlay.boxes
        : [],
  }
}
