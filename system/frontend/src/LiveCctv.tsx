import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Cctv, RotateCcw } from 'lucide-react'
import { Dialog } from './Dialogs'
import {
  RecentCameraVideo,
  cameraMedia,
  type MediaInfo,
} from './RecentCameraVideo'
import { AnalysisSwitch, AnalyzedPlayer } from './traffic-ai/AnalysisView'
import type { Intersection } from './types'

export type Camera = {
  id: string
  name: string
  district: string
  lat: number
  lon: number
  agency: string
  viewNote?: string
  siteId: string | null
}
type CatalogState = 'loading' | 'ready' | 'error'

export function useCameraCatalog(enabled: boolean) {
  const [cameras, setCameras] = useState<Camera[]>([])
  const [state, setState] = useState<CatalogState>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    fetch('/api/cctv/gits', { signal: ctrl.signal, cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw Error()
        return r.json() as Promise<Camera[]>
      })
      .then((rows) => {
        if (!ctrl.signal.aborted) {
          setCameras(rows.sort((a, b) => a.name.localeCompare(b.name, 'ko')))
          setState('ready')
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState('error')
      })
    return () => ctrl.abort()
  }, [enabled, attempt])
  return {
    cameras,
    state,
    retry: () => {
      setState('loading')
      setAttempt((n) => n + 1)
    },
  }
}
type Position = Pick<Intersection, 'lat' | 'lon'>
export function distance(a: Position, b: Position) {
  return (
    Math.hypot(
      a.lat - b.lat,
      (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180),
    ) * 111195
  )
}
export function adjacentCamera(site: Intersection, cameras: Camera[]) {
  return cameras.find((c) => c.siteId === site.id && distance(site, c) <= 70)
}
export function siteVideoLabel(
  site: Intersection,
  cameras: Camera[],
  state: CatalogState,
) {
  if (adjacentCamera(site, cameras)) return '현장 CCTV'
  return state === 'ready' ? '현장 영상 미확인' : '목록 확인 중'
}
export function formatDistance(meters: number) {
  return meters >= 1000
    ? (meters / 1000).toFixed(2) + ' km'
    : Math.round(meters) + ' m'
}
function HlsVideo({
  src,
  relay,
  name,
  analysis,
  overlay,
}: {
  src: string
  relay: string
  name: string
  analysis: boolean
  overlay: ReactNode
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState('영상 연결 중…')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const video = ref.current!
    let disposed = false,
      fallback = false,
      generation = 0
    let player: import('hls.js').default | undefined
    let timer: number | undefined
    function stopPlayer() {
      clearTimeout(timer)
      video.removeEventListener('error', onError)
      player?.destroy()
      player = undefined
    }
    function onError() {
      if (disposed) return
      if (!fallback) {
        fallback = true
        void attach(relay)
      } else {
        stopPlayer()
        setStatus('영상 연결이 끊겼어요.')
      }
    }
    function onPlaying() {
      clearTimeout(timer)
      setStatus(fallback ? '서버 중계로 재생 중' : '센터에서 직접 재생 중')
    }
    async function attach(url: string) {
      const current = ++generation
      stopPlayer()
      setStatus(fallback ? '서버 중계로 다시 연결 중…' : '센터에 직접 연결 중…')
      try {
        const { default: Hls } = await import('hls.js/light')
        if (disposed || current !== generation) return
        video.addEventListener('error', onError)
        timer = window.setTimeout(onError, fallback ? 20000 : 10000)
        if (Hls.isSupported()) {
          player = new Hls({
            maxBufferLength: 10,
            backBufferLength: 0,
            liveSyncDurationCount: 2,
            startFragPrefetch: true,
          })
          player.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal && !disposed && current === generation) onError()
          })
          player.loadSource(url)
          player.attachMedia(video)
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url
        } else {
          stopPlayer()
          setStatus('이 브라우저는 HLS 재생을 지원하지 않아요.')
        }
      } catch {
        if (!disposed && current === generation) onError()
      }
    }
    video.addEventListener('playing', onPlaying)
    void attach(src)
    return () => {
      disposed = true
      generation++
      stopPlayer()
      video.removeEventListener('playing', onPlaying)
      video.removeAttribute('src')
      video.load()
    }
  }, [src, relay, attempt])
  return (
    <>
      <div className="camera-pane live-video">
        <video
          ref={ref}
          crossOrigin="anonymous"
          disablePictureInPicture={analysis}
          controlsList={analysis ? 'nofullscreen' : undefined}
          autoPlay
          muted
          controls
          playsInline
          aria-label={name + ' 실시간 영상'}
          onPause={() =>
            setStatus((s) => (s.endsWith('재생 중') ? '일시정지' : s))
          }
        />
        {overlay}
      </div>
      <div className="live-status">
        <span role="status">{status}</span>
        <button
          className="subtle-button"
          onClick={() => setAttempt((n) => n + 1)}
        >
          <RotateCcw size={14} />
          다시 연결
        </button>
      </div>
    </>
  )
}
function GitsPlayer({
  camera,
  analysis,
  overlay,
}: {
  camera: Camera
  analysis: boolean
  overlay: ReactNode
}) {
  const [media, setMedia] = useState<MediaInfo | null>(null)
  const [status, setStatus] = useState('센터 영상 연결 중…')
  const [attempt, setAttempt] = useState(0)
  const reload = () => setAttempt((n) => n + 1)
  useEffect(() => {
    const ctrl = new AbortController()
    setMedia(null)
    setStatus('센터에 직접 연결 중…')
    cameraMedia(camera.id, ctrl.signal)
      .then((info) => {
        if (!ctrl.signal.aborted) setMedia(info)
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('센터 영상을 받을 수 없어요.')
      })
    return () => ctrl.abort()
  }, [camera.id, attempt])
  if (media?.kind === 'hls')
    return (
      <HlsVideo
        src={media.src}
        relay={media.relay}
        name={camera.name}
        analysis={analysis}
        overlay={overlay}
      />
    )
  if (media)
    return (
      <RecentCameraVideo
        key={attempt}
        first={media}
        id={camera.id}
        name={camera.name}
        analysis={analysis}
        overlay={overlay}
        reload={reload}
        switchToHls={setMedia}
      />
    )
  return (
    <>
      <div className="camera-pane live-video">
        <Cctv size={32} />
        <span>{camera.name}</span>
      </div>
      <div className="live-status">
        <span role="status">{status}</span>
        <button className="subtle-button" onClick={reload}>
          <RotateCcw size={14} />
          최신 영상 확인
        </button>
      </div>
    </>
  )
}

export function CameraPlayer({
  camera,
  analysis,
}: {
  camera: Camera
  analysis: boolean
}) {
  return (
    <AnalyzedPlayer
      camera={camera.id}
      enabled={analysis}
      player={(overlay) => (
        <GitsPlayer camera={camera} analysis={analysis} overlay={overlay} />
      )}
    />
  )
}

type Props = ReturnType<typeof useCameraCatalog> & {
  id: string
  select: (id: string) => void
  close: () => void
}
export function LiveCctvDialog({
  id,
  cameras,
  state,
  retry,
  select,
  close,
}: Props) {
  const [analysis, setAnalysis] = useState(false)
  const chosen =
    cameras.find((c) => c.id === id) ??
    (!id || id === 'gits'
      ? (cameras.find((c) => c.id === 'gits-6581') ?? cameras[0])
      : undefined)
  return (
    <Dialog title="중부권 시내 교차로 CCTV" close={close}>
      <AnalysisSwitch enabled={analysis} change={setAnalysis} />
      <p className="live-source">
        <Cctv size={16} />
        {chosen && `${chosen.agency} 제공 · `}경기도교통정보센터
      </p>
      {state === 'loading' ? (
        <p role="status">교차로 CCTV 목록을 불러오는 중이에요.</p>
      ) : state === 'error' || !cameras.length ? (
        <div className="live-status">
          <p role="status">
            {state === 'error'
              ? '카메라 목록을 받을 수 없어요.'
              : '현재 확인된 시내 교차로 CCTV가 없어요.'}
          </p>
          <button className="subtle-button" onClick={retry}>
            다시 조회
          </button>
        </div>
      ) : (
        <>
          <label className="select-label live-picker">
            촬영 위치 ({cameras.length}대)
            <select
              value={chosen?.id ?? ''}
              onChange={(e) => select(e.target.value)}
            >
              {!chosen && (
                <option value="" disabled>
                  교차로를 선택해 주세요
                </option>
              )}
              {cameras.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name} · {c.district}
                </option>
              ))}
            </select>
          </label>
          {chosen ? (
            <>
              {chosen.viewNote && (
                <p className="camera-note">{chosen.viewNote}</p>
              )}
              <CameraPlayer
                key={chosen.id}
                camera={chosen}
                analysis={analysis}
              />
            </>
          ) : (
            <p role="status">
              이 주소의 카메라는 중부권 시내 교차로 목록에 없어요.
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}
