import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { ScanLine } from 'lucide-react'
import { warmDetector } from './detector'
import { useTrafficAnalysis } from './useTrafficAnalysis'
import {
  registeredLanes,
  loadManualLanes,
  saveManualLanes,
  validManualLane,
  type LaneProfile,
} from './lane-profiles'
import {
  congestionGrade,
  queueGrade,
  countVisibleVehicles,
  vehicleNames,
  laneSections,
  type Box,
  type Point,
} from './metrics'
import license from '../models/analysis-licenses.txt?url'
import './analysis.css'

const letter = (index: number) => String.fromCharCode(65 + index)
export function AnalysisSwitch({
  enabled,
  change,
}: {
  enabled: boolean
  change: (value: boolean) => void
}) {
  useEffect(() => {
    const link = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string }
      }
    ).connection
    if (
      link?.saveData ||
      /(^|-)2g$/.test(link?.effectiveType ?? '') ||
      document.hidden
    )
      return
    const timer = window.setTimeout(warmDetector, 120)
    return () => clearTimeout(timer)
  }, [])
  return (
    <button
      type="button"
      className="analysis-switch"
      role="switch"
      aria-checked={enabled}
      onClick={() => change(!enabled)}
    >
      <ScanLine size={16} aria-hidden="true" />
      AI 분석 모드
      <span className="switch-track" aria-hidden="true">
        <i />
      </span>
    </button>
  )
}

function Overlay({
  profile,
  aspect,
  boxes,
  locations,
  labelSmall,
  editing,
  points,
  choose,
}: {
  profile: LaneProfile
  aspect: number
  boxes: Box[]
  locations: ReturnType<typeof countVisibleVehicles>['locations']
  labelSmall: boolean
  editing: boolean
  points: Point[]
  choose: (p: Point) => void
}) {
  const [cursor, setCursor] = useState<Point>([0.5, 0.5])
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])
  const h = 1000 / aspect
  const coords = (pts: Point[]) =>
    pts.map(([x, y]) => [x * 1000, y * h].join(',')).join(' ')
  function pick(e: PointerEvent<SVGSVGElement>) {
    if (!editing) return
    const svg = e.currentTarget,
      matrix = svg.getScreenCTM()
    if (!matrix) return
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      matrix.inverse(),
    )
    if (p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= h)
      choose([p.x / 1000, p.y / h])
  }
  return (
    <svg
      className={'analysis-overlay' + (editing ? ' editing' : '')}
      viewBox={'0 0 1000 ' + h}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={pick}
      ref={ref}
      tabIndex={editing ? 0 : undefined}
      aria-hidden={editing ? undefined : true}
      aria-label={
        editing
          ? '차로 꼭짓점 선택. 방향키로 이동하고 Enter로 지정해 주세요.'
          : undefined
      }
      onKeyDown={(e) => {
        if (!editing) return
        const steps: Record<string, Point> = {
          ArrowLeft: [-0.01, 0],
          ArrowRight: [0.01, 0],
          ArrowUp: [0, -0.01],
          ArrowDown: [0, 0.01],
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          choose(cursor)
        } else if (steps[e.key]) {
          e.preventDefault()
          const [x, y] = steps[e.key]
          setCursor(([a, b]) => [
            Math.min(1, Math.max(0, a + x)),
            Math.min(1, Math.max(0, b + y)),
          ])
        }
      }}
    >
      {profile.rearApproach && (
        <polygon
          className="rear-approach"
          points={coords(profile.rearApproach)}
        >
          <title>{profile.rearDirection} 방향 후방 접근로</title>
        </polygon>
      )}
      {profile.lanes.map((lane, i) => {
        const parts = laneSections(lane)
        const [a, b, c, d] = parts[parts.length - 1]
        const x = 0.07 * (a[0] + b[0]) + 0.43 * (c[0] + d[0]),
          y = 0.07 * (a[1] + b[1]) + 0.43 * (c[1] + d[1])
        const label = profile.labels?.[i]
        const secondDirection =
          label && label.direction !== profile.labels?.[0].direction
        return (
          <g key={i}>
            {label && (
              <title>
                {label.direction} 방향 · {label.movement}
              </title>
            )}
            <polygon
              className={
                'observed-lane' + (secondDirection ? ' other-direction' : '')
              }
              points={coords(lane)}
            />
            <text x={1000 * x} y={h * y} textAnchor="middle">
              {letter(i)}
            </text>
          </g>
        )
      })}
      {boxes.map((b, i) => {
        const { lane, inRear } = locations[i]
        const small = b.w <= 0.032
        return (
          <g key={b.trackId ?? i}>
            <rect
              className="vehicle-box"
              data-track-id={b.trackId}
              x={1000 * b.x}
              y={h * b.y}
              width={1000 * b.w}
              height={h * b.h}
            />
            {(!small || labelSmall) && (
              <text
                className={small ? 'vehicle-label compact' : 'vehicle-label'}
                x={1000 * b.x + 1}
                y={Math.max(14, h * b.y - 3)}
              >
                {vehicleNames[b.kind] ?? '차량'}
                {!small && b.trackId !== undefined && ` #${b.trackId}`}
                {lane >= 0
                  ? ' · ' + letter(lane)
                  : labelSmall && inRear
                    ? ' · 후방'
                    : ''}
              </text>
            )}
          </g>
        )
      })}
      {editing && (
        <g>
          <circle
            cx={cursor[0] * 1000}
            cy={cursor[1] * h}
            r="8"
            stroke="white"
            fill="none"
          />
          <polyline className="drawing-lane" points={coords(points)} />
          {points.map(([x, y], i) => (
            <circle key={i} cx={x * 1000} cy={y * h} r="5" fill="#ffcd62" />
          ))}
        </g>
      )}
    </svg>
  )
}

type Props = {
  camera: string
  enabled: boolean
  player: (overlay: ReactNode) => ReactNode
}
export function AnalyzedPlayer({ camera, enabled, player }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [manual, setManual] = useState(() => loadManualLanes(camera))
  const profile = manual ?? registeredLanes(camera)
  const [aspect, setAspect] = useState(0)
  const [storageHint, setStorageHint] = useState('')
  useEffect(() => {
    const container = host.current
    if (!container) return
    function syncSize() {
      const video = container?.querySelector<HTMLVideoElement>(
        'video:not([hidden])',
      )
      if (video?.videoWidth && video.videoHeight)
        setAspect(video.videoWidth / video.videoHeight)
    }
    const events = ['loadedmetadata', 'resize', 'playing']
    for (const event of events)
      container.addEventListener(event, syncSize, true)
    syncSize()
    return () => {
      for (const event of events)
        container.removeEventListener(event, syncSize, true)
    }
  }, [camera])
  function applyManual(next: LaneProfile | null) {
    const saved = saveManualLanes(camera, next)
    setManual(next)
    setStorageHint(
      saved
        ? ''
        : '브라우저 저장 공간을 사용할 수 없어 이번 화면에만 적용했어요.',
    )
  }
  const [drawing, setDrawing] = useState(false),
    [points, setPoints] = useState<Point[]>([])
  const [editHint, setEditHint] = useState('')
  const [retry, setRetry] = useState(0)
  const { frame, status, displayBoxes } = useTrafficAnalysis(
    host,
    camera,
    enabled,
    profile,
    retry,
  )
  useEffect(() => {
    if (!enabled) setDrawing(false)
  }, [enabled])
  const editing = enabled && drawing
  function start() {
    if (!aspect) return
    setPoints([])
    setEditHint('')
    setDrawing(true)
  }
  function choose(p: Point) {
    const next = [...points, p]
    if (next.length < 4) {
      setPoints(next)
      return
    }
    if (!validManualLane(next)) {
      setEditHint('네 꼭짓점이 겹치지 않게 다시 지정해 주세요.')
      setPoints([])
      return
    }
    applyManual({ lanes: [...(manual?.lanes ?? []), next] })
    setDrawing(false)
    setPoints([])
    setEditHint('')
  }
  const shown = enabled && frame?.profile === profile ? frame : null
  const countTracks = registeredLanes(camera).trackVehicles === true
  const stats = shown?.visible ? shown : null
  const visible = useMemo(
    () =>
      countVisibleVehicles(
        profile.lanes,
        displayBoxes,
        profile.rearApproach,
        stats?.motionById,
      ),
    [profile, displayBoxes, stats?.motionById],
  )
  const currentMotion = countTracks ? visible : stats
  const showVehicles = !!stats || (countTracks && displayBoxes.length > 0)
  const counts = countTracks ? visible.counts : (stats?.counts ?? [])
  const rearCount = countTracks ? visible.rearCount : stats?.rearCount
  return (
    <div
      ref={host}
      className="analyzed-player"
      style={
        aspect ? ({ '--video-aspect': aspect } as CSSProperties) : undefined
      }
    >
      <div className="analysis-media">
        {player(
          enabled && aspect > 0 && (
            <Overlay
              profile={profile}
              aspect={aspect}
              boxes={displayBoxes}
              locations={visible.locations}
              labelSmall={countTracks}
              editing={editing}
              points={points}
              choose={choose}
            />
          ),
        )}
      </div>
      {enabled && (
        <section className="analysis-readout" aria-label="AI 교통 분석">
          <div className="analysis-heading">
            <strong>
              <ScanLine size={16} /> AI 교통 분석
            </strong>
            {showVehicles && (
              <span className="detected-count">
                {countTracks ? '화면 차량' : '검출 차량'}{' '}
                {countTracks ? displayBoxes.length : stats?.boxes.length}대
              </span>
            )}
          </div>
          {showVehicles && !stats && status && <p role="status">{status}</p>}
          {!showVehicles && !shown ? (
            <p role="status">
              {status || '차량을 확인하고 있어요.'}{' '}
              {status.includes('못했어요') && (
                <button onClick={() => setRetry((r) => r + 1)}>
                  다시 시도
                </button>
              )}
            </p>
          ) : !showVehicles ? (
            <p>
              영상이 너무 어둡거나 선명하지 않아 혼잡도 판정을 기다리고 있어요.
            </p>
          ) : (
            <>
              {profile.lanes.length ? (
                <>
                  {[
                    ...new Set(
                      profile.lanes.map(
                        (_, i) => profile.labels?.[i]?.direction,
                      ),
                    ),
                  ].map((direction) => {
                    const indexes = profile.lanes
                      .map((_, i) => i)
                      .filter(
                        (i) => profile.labels?.[i]?.direction === direction,
                      )
                    const hasRear =
                      !!profile.rearApproach &&
                      direction === profile.rearDirection
                    const areas = hasRear
                      ? [...indexes, profile.lanes.length]
                      : indexes
                    const total =
                      indexes.reduce((n, i) => n + counts[i], 0) +
                      (hasRear ? (rearCount ?? 0) : 0)
                    const slow = areas.reduce(
                      (n, i) => n + (currentMotion?.slow[i] ?? 0),
                      0,
                    )
                    const observed = areas.reduce(
                      (n, i) => n + (currentMotion?.observed[i] ?? 0),
                      0,
                    )
                    const readable = areas.some((i) => stats?.readable[i])
                    const directionGrade = !stats
                      ? '측정 중'
                      : !readable
                        ? '시야 불량'
                        : queueGrade(total, observed, slow, 6)
                    return (
                      <div
                        className="lane-direction"
                        key={direction ?? 'manual'}
                      >
                        {direction && (
                          <h4>
                            {direction} 방향{' '}
                            <span>{indexes.length}개 차로</span>
                          </h4>
                        )}
                        {direction && countTracks && (
                          <p className="direction-queue">
                            차량 {total}대
                            {observed > 0 && ` · 서행·정지 ${slow}대`}
                            {directionGrade !== '차량 없음' && ' · '}
                            {['높음', '보통', '낮음'].includes(directionGrade)
                              ? '대기 혼잡 ' + directionGrade
                              : directionGrade === '차량 없음'
                                ? ''
                                : directionGrade}
                          </p>
                        )}
                        {direction === profile.rearDirection &&
                          profile.rearApproach && (
                            <p className="rear-count">
                              후방 접근로 ·{' '}
                              {!rearCount && stats?.rearReadable === false
                                ? '시야 불량'
                                : rearCount === undefined
                                  ? '측정 중'
                                  : '감지 차량 ' + rearCount + '대'}
                            </p>
                          )}
                        <div className="lane-readings">
                          {indexes.map((i) => {
                            const measured = stats?.counts[i] ?? 0
                            const slow = currentMotion?.slow[i] ?? 0,
                              observed = currentMotion?.observed[i] ?? 0
                            const lastPercent = stats?.percentages[i] ?? null
                            const pct =
                              countTracks &&
                              counts[i] > 0 &&
                              measured === 0 &&
                              lastPercent === 0
                                ? null
                                : lastPercent
                            const grade = stats
                              ? congestionGrade(
                                  pct,
                                  stats.readable[i],
                                  countTracks ? counts[i] : measured,
                                  slow,
                                  observed,
                                  countTracks,
                                )
                              : '측정 중'
                            return (
                              <div className="lane-reading" key={i}>
                                <b>
                                  {profile.labels
                                    ? letter(i) +
                                      ' · ' +
                                      profile.labels[i].movement
                                    : '차로 ' + letter(i)}
                                </b>
                                <span>{counts[i]}대</span>
                                <strong data-level={grade}>
                                  {grade}
                                  {pct !== null && ' · 점유 ' + pct + '%'}
                                </strong>
                                {observed > 0 && (
                                  <small>
                                    흐름 판정 {observed}대 중 서행·정지 {slow}대
                                  </small>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                  {profile.observationNote && (
                    <p className="observation-limit">
                      {profile.observationNote}
                    </p>
                  )}
                </>
              ) : (
                <p>
                  등록된 차로가 없어요. 영상에서 분석할 차로를 지정해 주세요.
                </p>
              )}
            </>
          )}
          {aspect > 0 && (
            <>
              {editing && (
                <p className="draw-help">
                  이 브라우저에 저장할 차로를 지정해요.{' '}
                  {editHint ||
                    [
                      '차로의 먼 쪽 왼쪽 끝',
                      '먼 쪽 오른쪽 끝',
                      '가까운 쪽 오른쪽 끝',
                      '가까운 쪽 왼쪽 끝',
                    ][points.length] + '을 영상에서 눌러 주세요.'}
                </p>
              )}
              <div className="analysis-options">
                <details>
                  <summary>혼잡도 기준</summary>
                  <p>
                    비율은 차로의 세로 6구간 중 차량이 관측된 구간을 최근 최대
                    5초 동안 평균한 값이에요. 30% 미만은 낮음으로 표시해요. 60%
                    이상이면 화면 속 차량의 크기와 이동량도 확인해요. 검출
                    차량의 절반 이상을 추적하고 그중 절반 이상이 서행하거나
                    멈췄을 때 높음으로 표시해요. 흐름을 확인할 수 없거나
                    반사광이 강하면 판정을 보류해요.
                  </p>
                  {countTracks && (
                    <p>
                      서행·정지 차량이 현재 대수의 절반 이상이고 한 차로에 4대
                      이상, 또는 한 방향에 6대 이상이면 해당 차로나 방향의 대기
                      혼잡을 높음으로 표시해요.
                    </p>
                  )}
                  <a href={license} target="_blank" rel="noreferrer">
                    분석 모델과 실행기 라이선스
                  </a>
                </details>
                {editing ? (
                  <button onClick={() => setDrawing(false)}>지정 취소</button>
                ) : (
                  <button onClick={start}>
                    {manual && profile.lanes.length
                      ? '차로 추가'
                      : '차로 직접 지정'}
                  </button>
                )}
                {!editing && document.fullscreenEnabled && (
                  <button
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen().catch(() => {})
                      else
                        void host.current?.requestFullscreen().catch(() => {})
                    }}
                  >
                    전체 화면 전환
                  </button>
                )}
                {manual && !editing && (
                  <button onClick={() => applyManual(null)}>기본 차로로</button>
                )}
              </div>
              {storageHint && <p role="status">{storageHint}</p>}
            </>
          )}
        </section>
      )}
    </div>
  )
}
