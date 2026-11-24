import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Cctv,
  FileVideo,
  LockKeyhole,
  MapPin,
  RadioTower,
  X,
} from 'lucide-react'
import {
  CameraPlayer,
  adjacentCamera,
  distance,
  formatDistance,
  type Camera,
} from './LiveCctv'
import { displayName, siteNumber, type Intersection } from './types'
import { AnalysisSwitch } from './traffic-ai/AnalysisView'

export function Dialog({
  title,
  children,
  close,
}: {
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => {
      dialog.close()
      previous?.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return
        const bounds = e.currentTarget.getBoundingClientRect()
        if (e.clientX < bounds.left || e.clientX > bounds.right ||
            e.clientY < bounds.top || e.clientY > bounds.bottom) close()
      }}
    >
      <div className="dialog-inner">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="닫기" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}
export function SiteDialog({
  site,
  close,
  cameras,
  openNearby,
}: {
  site: Intersection
  cameras: Camera[]
  openNearby: () => void
  close: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [bad, setBad] = useState(false)
  const [analysis, setAnalysis] = useState(false)
  const camera = adjacentCamera(site, cameras)
  useEffect(() => {
    if (!file) return
    const src = URL.createObjectURL(file)
    setUrl(src)
    setBad(false)
    return () => URL.revokeObjectURL(src)
  }, [file])
  return (
    <Dialog title={displayName(site)} close={close}>
      {camera && !file && <AnalysisSwitch enabled={analysis} change={setAnalysis} />}
      <div className="site-sub">
        <span className="id-chip">SI-{siteNumber(site)}</span>
        <span>
          <MapPin size={14} />
          {site.address}
        </span>
      </div>
      {camera && !file ? (
        <>
          <p className="live-source">
            {camera.agency} 제공 · {camera.name} ({camera.district}) · 교차로 좌표에서{' '}
            {formatDistance(distance(site, camera))}
          </p>
          <CameraPlayer key={camera.id} camera={camera} analysis={analysis} />
        </>
      ) : (
        <div className="camera-pane">
          {url && !bad ? (
            <video
              controls
              playsInline
              src={url}
              onError={() => setBad(true)}
            />
          ) : (
            <>
              <Cctv size={38} />
              <strong>
                {bad ? '이 영상을 재생할 수 없어요' : '현장 영상 미확인'}
              </strong>
              <p>
                {bad
                  ? '브라우저가 지원하는 동영상 파일을 선택해 주세요.'
                  : '이 지점에서 확인된 시내 교차로 CCTV가 없어요.'}
              </p>
            </>
          )}
        </div>
      )}
      <div className="file-row">
        <span>{file ? '녹화 · ' + file.name : '이 기기의 녹화 영상'}</span>
        <label className="subtle-button file-button">
          <FileVideo size={15} />
          녹화 파일 열기
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              if (e.target.files?.[0]) setFile(e.target.files[0])
              e.target.value = ''
            }}
          />
        </label>
      </div>
      {camera && file && (
        <button
          className="subtle-button site-live-link"
          onClick={() => {
            setUrl('')
            setFile(null)
            setBad(false)
          }}
        >
          센터 영상으로 돌아가기
        </button>
      )}
      <button className="subtle-button site-live-link" onClick={openNearby}>
        <Cctv size={15} />
        중부권 교차로 CCTV 목록
      </button>
      <div className="plan-note">
        <RadioTower size={20} />
        <div>
          <strong>녹색시간 권고 대기</strong>
          <p>현행 신호계획과 차량 측정값을 확보한 뒤 권고값을 표시해요.</p>
        </div>
      </div>
      <footer className="dialog-foot">
        <span>운영 모드에서는 권고만 확인할 수 있어요.</span>
        <button disabled>
          <LockKeyhole size={14} />
          실제 신호 적용
        </button>
      </footer>
    </Dialog>
  )
}
