import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import ComparisonResults from './ComparisonResults'
import EvaluationPanel from './EvaluationPanel'
import FieldValidation from './FieldValidation'
import type { MovementTraces } from './trafficMotion'
import './study.css'
import {
  Activity,
  CirclePause,
  Layers2,
  Play,
  RotateCcw,
  SlidersHorizontal,
  StepForward,
  Timer,
  Waypoints,
} from 'lucide-react'

const DundaeCase = lazy(() => import('./DundaeCase'))

const phases = ['동서 직진', '동서 좌회전', '남북 직진', '남북 좌회전']
const colors = ['#8db5ff', '#6fc2da', '#e3b76b', '#b8a7e5']
const plan = [30, 20, 30, 20]
const scenarios = {
  evening: {
    name: '퇴근 시간',
    rates: [900, 240, 480, 180],
    residual: [6, 0, 0, 0],
    condition: 'normal',
  },
  balanced: {
    name: '평상시',
    rates: [540, 210, 540, 210],
    residual: [0, 0, 0, 0],
    condition: 'normal',
  },
  morning: {
    name: '출근 방향 전환',
    rates: [480, 180, 900, 240],
    residual: [0, 0, 6, 0],
    condition: 'normal',
  },
  blocked: {
    name: '동서 직진 하류 막힘',
    rates: [900, 240, 480, 180],
    residual: [6, 0, 0, 0],
    condition: 'blocked',
  },
  missing: {
    name: '동서 직진 측정 결측',
    rates: [900, 240, 480, 180],
    residual: [6, 0, 0, 0],
    condition: 'missing',
  },
}
type Scenario = keyof typeof scenarios
type Mode = 'auto' | 'fixed' | 'manual'
type Decision = {
  arrivals?: number[][]
  departures?: number[][]
  recommended: number[]
  applied: number[]
  residual: number[]
  mean: (number | null)[]
  weights: number[]
  limits: (string | null)[]
  fallback: string | null
  oversaturated: boolean
}
async function advanceCycle(
  mode: Mode,
  previous: Decision | null,
  initial: (typeof scenarios)[Scenario],
  rates: number[],
  signal: AbortSignal,
  manual: number[] | null = null,
  traceCycle?: number,
): Promise<Decision> {
  const traced = traceCycle !== undefined
  const res = await fetch(traced ? '/api/simulation/trace-step' : '/api/simulation/step', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode,
      rates,
      manual,
      condition: initial.condition,
      residual: previous?.residual ?? initial.residual,
      current: (traced && mode === 'auto' ? previous?.recommended : previous?.applied) ?? plan,
      ...(traced ? { cycle: traceCycle, seed: 42 } : {}),
      mean: previous?.mean ?? null,
    }),
  })
  if (!res.ok)
    throw Error('배분을 계산하지 못했어요. 입력값과 서버 연결을 확인해 주세요.')
  return res.json()
}

const roadArms = [0, 90, 180, 270]
function Junction({ queues, overlay }: { queues: number[]; overlay: boolean }) {
  return (
    <svg
      className="junction"
      viewBox="0 0 400 260"
      role="img"
      aria-label="가상 교차로 도식과 현시별 잔류 차량"
    >
      <defs>
        <pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="#314751" strokeWidth=".6" />
        </pattern>
      </defs>
      <rect width="400" height="260" fill="#21353d" />
      <rect width="400" height="260" fill="url(#grid)" />
      <g transform="translate(200 130)">
        <path
          d="M-230 -40H-40V-160H40V-40H230V40H40V160H-40V40H-230Z"
          fill="#3b4b58"
          stroke="#64777e"
          strokeWidth="3"
        />
        {roadArms.map((angle) => (
          <g key={angle} transform={'rotate(' + angle + ')'}>
            <path
              d="M-1 -44V-211 M2 -44V-211"
              stroke="#c6ab65"
              strokeWidth="1.5"
            />
            <path
              d="M-20 -70V-212 M21 -70V-212"
              stroke="#91a2ae"
              strokeDasharray="7 7"
              strokeWidth="1.3"
            />
            {Array.from({ length: 13 }, (_, i) => (
              <path
                key={i}
                d={'M' + (-36 + i * 5.7) + ' -48v-10'}
                stroke="#bdc9cc"
                strokeWidth="3.6"
              />
            ))}
            <path d="M-37 -64h33" stroke="#cbd2d4" strokeWidth="2" />
          </g>
        ))}
        {[0, 1, 2, 3].map((i) => {
          const count = Math.min(5, Math.ceil(queues[i]))
          const angle = i < 2 ? 270 : 0
          const x = i % 2 ? -10 : -29
          return (
            <g key={i} transform={'rotate(' + angle + ')'}>
              {Array.from({ length: count }, (_, j) => (
                <g
                  key={j}
                  transform={'translate(' + x + ' ' + (-76 - j * 20) + ')'}
                >
                  <rect
                    x="-4"
                    y="-7"
                    width="8"
                    height="14"
                    rx="2"
                    fill={colors[i]}
                  />
                  <rect x="-3" y="-3" width="6" height="5" fill="#203849" />
                  {overlay && (
                    <rect
                      x="-6"
                      y="-9"
                      width="12"
                      height="18"
                      fill="none"
                      stroke="#a3c7ff"
                    />
                  )}
                </g>
              ))}
            </g>
          )
        })}
      </g>
      <g fill="#c6d5d9" fontFamily="sans-serif" fontSize="12">
        <text x="250" y="20">
          북
        </text>
        <text x="378" y="189">
          동
        </text>
        <text x="143" y="250">
          남
        </text>
        <text x="12" y="79">
          서
        </text>
      </g>
      {overlay && (
        <g fill="#bed8ff" fontFamily="sans-serif" fontSize="12">
          <text x="12" y="226">
            동서 잔류 {Math.round(queues[0] + queues[1])}대
          </text>
          <text x="12" y="245">
            남북 잔류 {Math.round(queues[2] + queues[3])}대
          </text>
        </g>
      )}
    </svg>
  )
}
const views = [
  { key: 'dundae', title: '둔대교차로 실측 사례', hash: '#simulation/dundae' },
  { key: 'evaluation', title: '운영안 비교 실험', hash: '#simulation/evaluation' },
  { key: 'replay', title: '교차로 재생', hash: '#simulation' },
  { key: 'field', title: '현장자료 대조', hash: '#simulation/field' },
] as const
export function isSimulationHash(hash: string) {
  return views.some(view => view.hash === hash)
}

function currentView() {
  return views.find(view => view.hash === window.location.hash)?.key ?? 'replay'
}

export function Simulation() {
  const [view, setView] = useState(currentView)
  useEffect(() => {
    const change = () => {
      setView(currentView())
      setPlaying(false)
    }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const [scenario, setScenario] = useState<Scenario>('evening')
  const [rates, setRates] = useState(scenarios.evening.rates)
  const [mode, setMode] = useState<Mode | 'compare'>('compare')
  const [manual, setManual] = useState(plan.map(String))
  const [decision, setDecision] = useState<Decision | null>(null)
  const [fixedDecision, setFixedDecision] = useState<Decision | null>(null)
  const [cycleStart, setCycleStart] = useState<{
    fixed: number[]
    auto: number[]
    rates: number[]
    traces: MovementTraces
  } | null>(null)
  const [cycle, setCycle] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const base = scenarios[scenario]
  const queues = decision?.residual ?? base.residual
  function restartCycles() {
    pending.current?.abort()
    pending.current = null
    setCycle(0)
    setDecision(null)
    setFixedDecision(null)
    setCycleStart(null)
    setPlaying(false)
    setBusy(false)
    setError('')
  }
  function reset(next: Scenario) {
    restartCycles()
    setScenario(next)
    setRates(scenarios[next].rates)
    setManual(plan.map(String))
  }
  async function step() {
    if (pending.current) return
    const ctrl = new AbortController()
    pending.current = ctrl
    setBusy(true)
    setError('')
    try {
      const numbers = manual.map(Number)
      if (
        mode === 'manual' &&
        numbers.some(
          (v, i) =>
            !Number.isInteger(v) ||
            v < Math.max(15, plan[i] - 10) ||
            v > Math.min(45, plan[i] + 10),
        )
      )
        throw Error('현시별 허용 범위 안에서 정수 초로 입력해 주세요.')
      if (mode === 'manual' && numbers.reduce((a, b) => a + b, 0) !== 100)
        throw Error('네 현시의 녹색시간 합을 100초로 맞춰 주세요.')
      const [data, baseline] = await Promise.all([
        advanceCycle(
          mode === 'compare' ? 'auto' : mode,
          decision,
          base,
          rates,
          ctrl.signal,
          mode === 'manual' ? numbers : null,
          mode === 'compare' ? cycle : undefined,
        ),
        mode === 'compare'
          ? advanceCycle('fixed', fixedDecision, base, rates, ctrl.signal, null, cycle)
          : null,
      ])
      if (ctrl.signal.aborted) return
      if (baseline) {
        if (!data.arrivals || !data.departures || !baseline.departures)
          throw Error('차량 이동 기록을 받지 못했습니다.')
        setCycleStart({
          traces: { arrivals: data.arrivals, fixedDepartures: baseline.departures, autoDepartures: data.departures },
          fixed: fixedDecision?.residual ?? base.residual,
          auto: queues,
          rates,
        })
      }
      setDecision(data)
      setFixedDecision(baseline)
      setCycle((c) => c + 1)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        ctrl.abort()
        setError(err instanceof Error ? err.message : '계산에 실패했어요.')
        setPlaying(false)
      }
    } finally {
      if (pending.current === ctrl) {
        pending.current = null
        setBusy(false)
      }
    }
  }
  useEffect(
    () => () => {
      pending.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (mode === 'compare' || !playing || busy) return
    const timer = window.setTimeout(() => {
      void step()
    }, 2000)
    return () => clearTimeout(timer)
  })
  const playbackControls = (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="sim-buttons">
        <button
          className="primary"
          disabled={busy || playing}
          onClick={() => void step()}
        >
          <StepForward size={16} />
          다음 주기
        </button>
        <button
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <CirclePause size={16} /> : <Play size={16} />}{' '}
          {playing ? '일시정지' : '자동 진행'}
        </button>
        <button
          className="icon-button"
          aria-label="시뮬레이션 초기화"
          onClick={() => reset(scenario)}
        >
          <RotateCcw size={16} />
        </button>
      </div>
    </>
  )
  return (
    <div className="simulation">
      <label className="study-picker">
        <span id="study-view-label">분석 화면</span>
        <select
          aria-labelledby="study-view-label"
          value={views.find(v => v.key === view)?.hash}
          onChange={e => window.location.assign(e.target.value)}
        >
          {views.map(v => (
            <option key={v.key} value={v.hash}>{v.title}</option>
          ))}
          <option value="/cases/city-hall-survey.html">시청입구 삼거리 교통량</option>
        </select>
      </label>
      <nav className="study-views" aria-label="시뮬레이션 분석 화면">
        {views.map(v => <a key={v.key} href={v.hash} aria-current={view === v.key ? 'page' : undefined}>{v.title}</a>)}
        <a href="/cases/city-hall-survey.html">시청입구 삼거리 교통량</a>
      </nav>
      {view === 'replay' && <div className="sim-overview">
        <div>
          <span className="sim-icon">
            <Waypoints />
          </span>
          <div>
            <strong>가상 사거리</strong>
            <small>직진과 좌회전, 네 가지 신호</small>
          </div>
        </div>
        <div>
          <Timer />
          <span>
            고정 주기 <b>120초</b>
          </span>
        </div>
        <div>
          <Activity />
          <span>
            녹색시간 합 <b>100초</b>
          </span>
        </div>
        <div>
          <Layers2 />
          <span>
            계산 완료 <b>{cycle}주기</b>
          </span>
        </div>
      </div>}
      {view === 'dundae' && <Suspense fallback={<p role="status">둔대교차로 조사표와 비교 결과를 불러오고 있습니다.</p>}><DundaeCase /></Suspense>}
      {view === 'field' && <FieldValidation />}
      {(view === 'replay' || view === 'evaluation') && <>
      <div className={view === 'evaluation' ? 'study-layout' : mode === 'compare' ? 'sim-layout comparison-layout' : 'sim-layout'}>
        <section className="card">
          <div className="panel-head">
            <div className="panel-title">
              <SlidersHorizontal />
              <h2>{view === 'evaluation' ? '실험 교통 수요' : '교통 수요 설정'}</h2>
            </div>
          </div>
          <div className="sim-inputs">
            <label className="select-label">
              시나리오
              <select
                value={scenario}
                onChange={(e) => reset(e.target.value as Scenario)}
              >
                {Object.entries(scenarios).map(([key, v]) => (
                  <option key={key} value={key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <h3>
              방향별로 들어오는 차 <small>대/시간</small>
            </h3>
            {phases.map((p, i) => (
              <label className="rate" key={p}>
                <span>
                  <i style={{ background: colors[i] }} />
                  {p}
                  <b>{rates[i].toLocaleString('ko-KR')}</b>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1800"
                  step="30"
                  value={rates[i]}
                  onChange={(e) =>
                    setRates((r) =>
                      r.map((v, j) => (i === j ? Number(e.target.value) : v)),
                    )
                  }
                />
              </label>
            ))}
            {view === 'replay' && <>
            <label className="select-label">
              제어 방식
              <select
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value as typeof mode
                  if (mode === 'compare' || next === 'compare') restartCycles()
                  setMode(next)
                  setPlaying(false)
                  setError('')
                }}
              >
                <option value="compare">고정 신호 · 자동 배분 비교</option>
                <option value="auto">AI 자동 배분</option>
                <option value="fixed">기준 고정 계획</option>
                <option value="manual">수동 조정</option>
              </select>
            </label>
            {mode === 'manual' && (
              <div className="manual">
                {phases.map((p, i) => (
                  <label key={p}>
                    {p} (초)
                    <input
                      type="number"
                      min={Math.max(15, plan[i] - 10)}
                      max={plan[i] + 10}
                      value={manual[i]}
                      onChange={(e) =>
                        setManual((m) =>
                          m.map((v, j) => (i === j ? e.target.value : v)),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            <p className="hint">
              {mode === 'compare'
                ? '유입량을 바꾸면 다음 주기부터 두 방식에 함께 반영돼요.'
                : '유입량과 제어 방식은 다음 주기부터 반영돼요.'}
            </p>
            {mode !== 'compare' && playbackControls}
            </>}
          </div>
        </section>
        {view === 'evaluation' ? (
          <EvaluationPanel rates={rates} initial={base.residual} condition={base.condition} scenarioName={base.name} />
        ) : mode === 'compare' ? (
          <ComparisonResults
            traces={cycleStart?.traces}
            playback={{
              busy,
              error,
              continuous: playing,
              setContinuous: setPlaying,
              onNext: step,
              onReset: () => reset(scenario),
            }}
            phases={phases}
            fixed={fixedDecision?.residual ?? base.residual}
            auto={queues}
            fixedStart={cycleStart?.fixed ?? base.residual}
            autoStart={cycleStart?.auto ?? base.residual}
            fixedGreen={fixedDecision?.applied ?? plan}
            autoGreen={decision?.applied ?? plan}
            hourlyRates={cycleStart?.rates ?? rates}
            condition={base.condition}
            cycle={cycle}
          />
        ) : <section className="card sim-results">
          <div className="panel-head">
            <div className="panel-title">
              <Waypoints />
              <h2>신호 배분 결과</h2>
            </div>
            <span className="status-tag amber">가상 설정</span>
          </div>
          <div className="sim-body">
            <div>
              <div className="junction-frame">
                <Junction queues={queues} overlay={overlay} />
              </div>
              <label className="overlay-control">
                <input
                  type="checkbox"
                  checked={overlay}
                  onChange={(e) => setOverlay(e.target.checked)}
                />{' '}
                잔류 표시
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <caption>현시별 녹색시간 (초)</caption>
                <thead>
                  <tr>
                    <th>현시</th>
                    <th>기준</th>
                    <th>권고</th>
                    <th>적용</th>
                  </tr>
                </thead>
                <tbody>
                  {phases.map((p, i) => (
                    <tr key={p}>
                      <th>
                        <i style={{ background: colors[i] }} />
                        {p}
                      </th>
                      <td>{plan[i]}</td>
                      <td>{decision?.recommended[i] ?? '—'}</td>
                      <td>{decision?.applied[i] ?? plan[i]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="split-area">
            <h3>적용 녹색시간</h3>
            <div className="split-bar">
              {(decision?.applied ?? plan).map((v, i) => (
                <div
                  key={i}
                  title={phases[i]}
                  style={{ flex: v, background: colors[i] }}
                >
                  {v}초
                </div>
              ))}
            </div>
            <p className="hint" aria-live="polite">
              {!decision
                ? '다음 주기를 계산하면 AI 권고값을 확인할 수 있어요.'
                : decision.fallback
                  ? '측정값이 누락되어 기준 계획으로 복귀하는 권고를 계산했어요.'
                  : decision.oversaturated
                    ? '수요가 가용 녹색시간을 초과했어요.'
                    : cycle + '번째 주기의 유입량과 잔류 차량을 반영했어요.'}
            </p>
            {decision && !decision.fallback && (
              <details className="decision-details">
                <summary>AI 권고 근거</summary>
                <table>
                  <caption>유입량과 잔류 대기로 계산한 현시별 가중치</caption>
                  <thead>
                    <tr>
                      <th>현시</th>
                      <th>수요 가중치</th>
                      <th>목표 녹색시간 제약</th>
                    </tr>
                  </thead>
                  <tbody>
                    {phases.map((phase, i) => (
                      <tr key={phase}>
                        <th>{phase}</th>
                        <td>{(decision.weights[i] * 100).toFixed(1)}%</td>
                        <td>
                          {decision.limits[i] === 'upper'
                            ? '상한 도달'
                            : decision.limits[i] === 'lower'
                              ? '하한 도달'
                              : '범위 안'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        </section>}
      </div>
      {view === 'replay' && mode !== 'compare' && (
        <p className="source-note">
          단일 방식은 녹색시간 산식을 살펴보는 간이 계산입니다. 주기 유입량과 통과 용량으로 잔류를 추정하며 그림은 현시당
          최대 5대를 표시해요.
        </p>
      )}
      </>}
    </div>
  )
}
