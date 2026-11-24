import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

export type MediaInfo = { kind: 'hls' | 'mp4'; src: string; relay: string }

export async function cameraMedia(
  id: string,
  signal: AbortSignal,
): Promise<MediaInfo> {
  const response = await fetch('/api/cctv/gits/' + id.slice(5) + '/view', {
    signal,
    cache: 'no-store',
  })
  if (!response.ok) throw Error('camera media unavailable')
  return response.json()
}

function bufferedAhead(video: HTMLVideoElement) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (
      video.buffered.start(i) <= video.currentTime + 0.1 &&
      video.buffered.end(i) > video.currentTime
    )
      return video.buffered.end(i) - video.currentTime
  }
  return 0
}

type ClipProps = {
  media: MediaInfo
  active: boolean
  neededAtEnd: boolean
  analysis: boolean
  name: string
  ready: (value: boolean) => void
  nearEnd: () => void
  ended: () => void
  failed: () => void
  status: (value: string) => void
  settings: { muted: boolean; volume: number; rate: number }
}

function Clip(props: ClipProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const latest = useRef(props)
  latest.current = props
  const check = useRef<() => void>(() => {})
  useEffect(() => {
    const video = ref.current!
    let route: 'direct' | 'plain' | 'relay' = 'direct'
    let closed = false,
      broken = false,
      needsPlay = true,
      notified = false,
      playingRequest = false
    let lastProgress = performance.now(),
      previousEnd = -1,
      previousTime = -1,
      resumeAt = 0
    let played = false
    const direct = new URL(props.media.src, location.href)
    // 센터의 고정 주소에서 새 클립을 조회할 때 브라우저가 이전 요청을 재사용하지 않게 합니다.
    if (direct.origin === 'https://gitsview.gg.go.kr')
      direct.searchParams.set('_clip', String(Date.now()))
    function status(text: string) {
      if (latest.current.active) latest.current.status(text)
    }
    function attach() {
      needsPlay = true
      played = false
      playingRequest = false
      if (notified && !latest.current.active) latest.current.ready(false)
      notified = false
      lastProgress = performance.now()
      previousEnd = -1
      previousTime = -1
      if (route === 'plain') video.removeAttribute('crossorigin')
      else video.crossOrigin = 'anonymous'
      video.src = route === 'relay' ? props.media.relay : direct.href
      video.load()
    }
    function recover() {
      if (closed || broken) return
      resumeAt = Math.max(resumeAt, video.currentTime)
      if (
        route === 'direct' &&
        !latest.current.analysis &&
        video.error &&
        !video.currentTime
      )
        route = 'plain'
      else if (route !== 'relay') route = 'relay'
      else {
        broken = true
        status('센터 영상 연결이 끊겼어요.')
        latest.current.failed()
        return
      }
      status('영상에 다시 연결하고 있어요.')
      attach()
    }
    function inspect() {
      if (closed || broken || video.ended) return
      const p = latest.current
      if (route === 'plain' && p.analysis) {
        recover()
        return
      }
      const ahead = bufferedAhead(video),
        end = video.currentTime + ahead
      if (
        end > previousEnd + 0.05 ||
        Math.abs(video.currentTime - previousTime) > 0.1
      ) {
        lastProgress = performance.now()
        previousEnd = end
        previousTime = video.currentTime
      }
      const remaining = video.duration - video.currentTime
      const bufferedToEnd = remaining > 0 && ahead >= remaining - 0.15
      const primed = video.readyState >= 2 && (ahead >= 3 || bufferedToEnd)
      // 일부 모바일 브라우저는 play()를 호출하기 전에는 메타데이터까지만 받습니다.
      const limitedPreload =
        (!played || (needsPlay && ahead >= 0.5)) &&
        video.readyState >= 1 &&
        performance.now() - lastProgress > 2500
      if (
        !p.active &&
        (primed || (p.neededAtEnd && limitedPreload)) &&
        !notified
      ) {
        notified = true
        p.ready(true)
      }
      if (
        p.active &&
        needsPlay &&
        (primed || limitedPreload) &&
        !playingRequest &&
        !video.seeking
      ) {
        needsPlay = false
        playingRequest = true
        video.muted = p.settings.muted
        video.volume = p.settings.volume
        video.playbackRate = p.settings.rate
        void video
          .play()
          .catch((e: DOMException) => {
            if (!closed && e.name === 'NotAllowedError')
              status('재생 버튼을 눌러 주세요.')
          })
          .finally(() => {
            playingRequest = false
          })
      }
      if (
        p.active &&
        !video.paused &&
        remaining <= 15 &&
        (ahead >= 3 || remaining <= 4)
      )
        p.nearEnd()
      if (
        (!video.paused || needsPlay) &&
        !video.seeking &&
        !bufferedToEnd &&
        ahead < 0.3 &&
        performance.now() - lastProgress > 14000 &&
        !document.hidden
      )
        recover()
    }
    function metadata() {
      if (resumeAt > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(
          resumeAt,
          Math.max(0, video.duration - 0.2),
        )
        resumeAt = 0
      }
      inspect()
    }
    function waiting() {
      if (
        !latest.current.active ||
        !played ||
        video.paused ||
        video.ended ||
        video.seeking
      )
        return
      if (bufferedAhead(video) < 0.5) {
        needsPlay = true
        video.pause()
        status('영상이 끊겨 다음 장면을 준비하고 있어요.')
      }
    }
    function playing() {
      needsPlay = false
      played = true
      status(
        route === 'relay'
          ? '센터 최근 영상 · 서버 중계'
          : '센터 최근 영상 · 직접 재생',
      )
    }
    function settings() {
      if (!latest.current.active) return
      Object.assign(latest.current.settings, {
        muted: video.muted,
        volume: video.volume,
        rate: video.playbackRate,
      })
    }
    function ended() {
      if (latest.current.active) latest.current.ended()
    }
    const listeners: [string, () => void][] = [
      ['progress', inspect],
      ['canplay', inspect],
      ['timeupdate', inspect],
      ['loadedmetadata', metadata],
      ['playing', playing],
      ['ended', ended],
      ['waiting', waiting],
      ['error', recover],
      ['volumechange', settings],
      ['ratechange', settings],
    ]
    for (const [event, fn] of listeners) video.addEventListener(event, fn)
    check.current = inspect
    const timer = window.setInterval(inspect, 400)
    attach()
    return () => {
      closed = true
      clearInterval(timer)
      for (const [event, fn] of listeners) video.removeEventListener(event, fn)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [props.media])
  useEffect(() => {
    check.current()
  }, [props.active, props.analysis, props.neededAtEnd])
  return (
    <video
      ref={ref}
      hidden={!props.active}
      controls={props.active}
      preload="auto"
      muted
      playsInline
      disablePictureInPicture={props.analysis}
      controlsList={props.analysis ? 'nofullscreen' : undefined}
      aria-label={props.active ? props.name + ' 최근 영상' : undefined}
    />
  )
}

export function RecentCameraVideo({
  first,
  id,
  name,
  analysis,
  overlay,
  reload,
  switchToHls,
}: {
  first: MediaInfo
  id: string
  name: string
  analysis: boolean
  overlay: ReactNode
  reload: () => void
  switchToHls: (media: MediaInfo) => void
}) {
  const [current, setCurrent] = useState({ sequence: 0, media: first })
  const [next, setNext] = useState<MediaInfo | null>(null)
  const [prepare, setPrepare] = useState(false),
    [finished, setFinished] = useState(false)
  const [ready, setReady] = useState(false),
    [retry, setRetry] = useState(0)
  const [status, setStatus] = useState('센터에 직접 연결 중…')
  const settings = useRef({ muted: true, volume: 1, rate: 1 })
  useEffect(() => {
    if (!prepare) return
    const controller = new AbortController()
    let timer: number
    async function request() {
      try {
        const media = await cameraMedia(id, controller.signal)
        if (!controller.signal.aborted) setNext(media)
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(request, 3000)
      }
    }
    timer = window.setTimeout(request, retry ? 2500 : 0)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, prepare, retry])
  useEffect(() => {
    if (!finished || !next || (!ready && next.kind === 'mp4')) return
    if (next.kind === 'hls') {
      switchToHls(next)
      return
    }
    setCurrent({ sequence: current.sequence + 1, media: next })
    setNext(null)
    setFinished(false)
    setPrepare(false)
    setReady(false)
    setRetry(0)
  }, [current.sequence, finished, next, ready, switchToHls])
  function finish() {
    setFinished(true)
    setPrepare(true)
    setStatus('다음 센터 영상을 연결하고 있어요.')
  }
  const clips = [current]
  if (next?.kind === 'mp4')
    clips.push({ sequence: current.sequence + 1, media: next })
  return (
    <>
      <div className="camera-pane live-video">
        {clips.map(({ sequence, media }) => (
          <Clip
            key={sequence}
            media={media}
            active={sequence === current.sequence}
            name={name}
            analysis={analysis}
            settings={settings.current}
            neededAtEnd={finished}
            nearEnd={() => setPrepare(true)}
            ended={finish}
            status={setStatus}
            ready={setReady}
            failed={() => {
              if (sequence === current.sequence) finish()
              else {
                setReady(false)
                setNext(null)
                setRetry((n) => n + 1)
              }
            }}
          />
        ))}
        {overlay}
      </div>
      <div className="live-status">
        <span role="status">{status}</span>
        <button className="subtle-button" onClick={reload}>
          <RotateCcw size={14} />
          최신 영상 확인
        </button>
      </div>
      <p className="hint">
        센터가 제공하는 최근 영상을 이어서 재생해요. 센터 갱신 시점에 따라 같은
        장면이 나올 수 있어요.
      </p>
    </>
  )
}
