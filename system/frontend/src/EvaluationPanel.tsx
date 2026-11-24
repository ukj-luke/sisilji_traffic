import { useEffect, useId, useRef, useState } from 'react'
import { ChartNoAxesCombined, Download, FlaskConical, Play, Printer } from 'lucide-react'
import './evaluation.css'

type Props = { rates: number[]; initial: number[]; condition: string; scenarioName: string }
type Profile = 'steady' | 'surge'
type Inputs = Pick<Props, 'rates' | 'initial' | 'condition'> & { cycles: number; replications: number; seed: number; profile: Profile }
type Method = 'fixed' | 'tod' | 'adaptive'
type DirectionResult = { wait_s: number | null; demand: number; served: number; end_queue: number }
type Metrics = Omit<DirectionResult, 'demand'> & {
  peak_queue: number
  by_direction: DirectionResult[]
  cycle_end_queue: number[]
}
type Difference = { delta_wait_s: number | null; ci95: [number, number] | null; n: number }
type Result = {
  model_version: string
  inputs: Inputs
  expected_rates_by_cycle: number[][]
  tod_mean_rates: number[]
  plans: { fixed: number[]; tod: number[] }
  methods: Record<Method, Metrics>
  paired: { vs_fixed: Difference; vs_tod: Difference }
  startup_sensitivity: {
    initial_greens: number[]
    warmup_cycles: number
    adaptive_wait_s: number | null
    vs_tod: Difference
    primary_saved_vehicle_hours: { mean: number; ci95: [number, number] | null; n: number }
  }
  demand_mean: number
  worst_direction: { index: number; delta_wait_s: number } | null
  runs: { seed: number; demand: number; fixed_wait_s: number | null; tod_wait_s: number | null; adaptive_wait_s: number | null }[]
}
const methods: Method[] = ['fixed', 'tod', 'adaptive']
const names = { fixed: '기준 고정', tod: '시간대별 고정', adaptive: '자동 배분' }
const colors = { fixed: 'var(--fixed-series)', tod: 'var(--tod-series)', adaptive: 'var(--adaptive-series)' }
const directions = ['동서 직진', '동서 좌회전', '남북 직진', '남북 좌회전']
const profileNames = { steady: '일정한 평균 수요', surge: '중간 구간 동서 직진 50% 증가' }
const numeric = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 })
const seconds = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const num = (v: number | null) => v === null ? '—' : numeric.format(v)
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + seconds.format(Math.abs(v))

function inputKey(i: Inputs) {
  return JSON.stringify([i.rates, i.initial, i.condition, i.cycles, i.replications, i.seed, i.profile])
}

function downloadResult(result: Result, scenario: string) {
  const report = {
    scenario,
    source: '가상 교차로 모의실험',
    directions,
    units: { rates: '대/시간', queues: '대', wait_s: '초/대', greens: '초', served: '분석기간 내 통과 대수' },
    interpretation: 'paired 차이는 자동 배분에서 비교 방식의 평균 대기를 뺀 값입니다. counts와 그래프는 반복 평균입니다.',
    ...result,
  }
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `시흥_신호운영_모의실험_${scenario}_seed${result.inputs.seed}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function QueueChart({ result }: { result: Result }) {
  const titleId = useId()
  const container = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(570)
  useEffect(() => {
    if (!container.current) return
    const resize = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))))
    resize.observe(container.current)
    return () => resize.disconnect()
  }, [])
  const plot = { left: 48, right: width - 9, top: 20, bottom: 157 }
  const cycles = result.inputs.cycles
  const initial = result.inputs.initial.reduce((sum, cars) => sum + cars, 0)
  const series = methods.map(method => [initial, ...result.methods[method].cycle_end_queue])
  const high = Math.max(1, ...series.flat())
  const magnitude = Math.pow(10, Math.floor(Math.log10(high)))
  const ceiling = Math.ceil(high / magnitude * 2) * magnitude / 2
  const x = (cycle: number) => plot.left + (plot.right - plot.left) * cycle / cycles
  const y = (cars: number) => plot.bottom - (plot.bottom - plot.top) * cars / ceiling
  const ticks = Array.from(new Set([0, Math.round(cycles / 2), cycles]))
  return <figure className="eval-chart" ref={container}>
    <figcaption><h3>시간에 따라 줄이 쌓이는가</h3><span>주기 종료 시 네 방향의 대기 차량 합 · 반복 평균</span></figcaption>
    <ul className="eval-legend">{methods.map(method =>
      <li key={method}><i className={'eval-key ' + method} />{names[method]}</li>
    )}</ul>
    <svg viewBox={`0 0 ${width} 188`} role="img" aria-labelledby={titleId}>
      <title id={titleId}>0주기부터 {cycles}주기까지 남은 대기 차량 수. 마지막 주기의 방식별 대수는 위 성과표에 표시됩니다.</title>
      {[0, ceiling / 2, ceiling].map(v => <g key={v}>
        <line x1={plot.left} x2={plot.right} y1={y(v)} y2={y(v)} stroke="#dbe5e5" />
        <text x={plot.left - 6} y={y(v) + 4} textAnchor="end">{num(v)}대</text>
      </g>)}
      {ticks.map(cycle => <text key={cycle} x={x(cycle)} y="178" textAnchor={cycle === cycles ? 'end' : 'middle'}>{cycle}주기</text>)}
      {methods.map((method, index) => <polyline key={method}
        points={series[index].map((cars, cycle) => x(cycle) + ',' + y(cars)).join(' ')}
        fill="none" stroke={colors[method]} strokeWidth={method === 'adaptive' ? 2.6 : 2.1}
        strokeDasharray={method === 'fixed' ? '2 4' : method === 'tod' ? '8 4' : undefined}
        strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
    </svg>
  </figure>
}

function ExperimentResults({ result, scenario, busy }: { result: Result; scenario: string; busy: boolean }) {
  const methodsNote = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    let wasOpen = false
    let previousTitle = document.title
    const before = () => {
      previousTitle = document.title
      document.title = `시흥 신호 운영 비교 실험 · ${scenario} · 시드 ${result.inputs.seed}`
      if (methodsNote.current) { wasOpen = methodsNote.current.open; methodsNote.current.open = true }
    }
    const after = () => {
      document.title = previousTitle
      if (methodsNote.current) methodsNote.current.open = wasOpen
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [result, scenario])
  const { delta_wait_s: delta, ci95: ci } = result.paired.vs_tod
  const verdict = !ci ? '차이를 추정할 수 없음'
    : ci[1] < 0 ? '자동 배분에서 대기 감소'
    : ci[0] > 0 ? '자동 배분에서 대기 증가'
    : '어느 방식의 대기가 짧은지 불확실'
  const change = ci && ci[1] < 0 ? 'gain' : ci && ci[0] > 0 ? 'loss' : 'neutral'
  const inputs = result.inputs
  const sensitivity = result.startup_sensitivity
  const conditionName = inputs.condition === 'blocked' ? '동서 직진 하류 막힘' : inputs.condition === 'missing' ? '동서 직진 관측 결측' : '정상'
  return <article className="eval-report">
    <div className="eval-print-only eval-print-header"><p>시흥 교통관제 · 대안 평가</p><h1>가상 교차로 신호 운영 비교 보고서</h1>
      <p>단일 가상 교차로에서 얻은 추정치입니다. 현장 관측과 대조한 뒤 지역 교차로의 적용 가능성을 판단할 수 있습니다.</p></div>
    <div className="eval-result-heading">
      <div><h3>실험 결과</h3><p>{scenario} · {profileNames[inputs.profile]} · {inputs.cycles * 2}분 관찰 · {inputs.replications}회 반복 · 시드 {inputs.seed}</p></div>
      <div className="eval-exports">
        <button type="button" className="eval-download" disabled={busy} onClick={() => window.print()}><Printer size={16} />인쇄·PDF 저장</button>
        <button type="button" className="eval-download" disabled={busy} onClick={() => downloadResult(result, scenario)}><Download size={16} />결과 JSON 저장</button>
      </div>
    </div>
    <div className="eval-print-only eval-print-inputs"><p>관측 조건 {conditionName} · {inputs.cycles}주기 · 모형 {result.model_version}</p>
      <table><thead><tr><th>실험 입력</th>{directions.map(d => <th key={d}>{d}</th>)}</tr></thead><tbody>
        <tr><th>기본 수요 (대/시간)</th>{inputs.rates.map((v, i) => <td key={i}>{num(v)}</td>)}</tr>
        <tr><th>초기 대기 (대)</th>{inputs.initial.map((v, i) => <td key={i}>{num(v)}</td>)}</tr>
        <tr><th>고정 계획 설계 수요 (대/시간)</th>{result.tod_mean_rates.map((v, i) => <td key={i}>{num(v)}</td>)}</tr>
      </tbody></table></div>
    <section className={'eval-verdict ' + change} aria-label="자동 배분과 시간대별 고정 신호의 비교">
      <div><p>자동 배분 − 시간대별 고정</p>
        <strong>{delta === null ? '—' : signed(delta)} <small>초/대</small></strong>
      </div>
      <div><h4>{verdict}</h4><p>{ci
        ? `대기 차이의 95% 신뢰구간은 ${signed(ci[0])} ~ ${signed(ci[1])}초/대입니다.`
        : '비교할 차량 또는 유효한 반복이 부족합니다.'}</p></div>
    </section>
    {sensitivity && <div className="eval-economic">
      <section>
        <h4>시작 신호를 맞춰도 같은 결과인가</h4>
        <p>기본 실험의 첫 주기는 자동 배분 {result.plans.fixed.join('/')}초, 시간대별 고정 {result.plans.tod.join('/')}초로 시작합니다. 준비 주기 없이 첫 주기부터 집계합니다.</p>
        <p>두 방식 모두 시간대별 고정 계획에서 시작하면 차량당 대기 차이는 <strong>{sensitivity.vs_tod.delta_wait_s === null ? '산출 불가' : signed(sensitivity.vs_tod.delta_wait_s) + '초/대'}</strong>입니다. {sensitivity.vs_tod.ci95 && `95% 신뢰구간은 ${signed(sensitivity.vs_tod.ci95[0])} ~ ${signed(sensitivity.vs_tod.ci95[1])}초/대입니다.`}</p>
      </section>
      <section>
        <h4>관찰한 {inputs.cycles * 2}분 동안 전체 차량의 대기</h4>
        <p>기본 실험에서 자동 배분의 전체 대기시간은 시간대별 고정과 비교해 <strong>{sensitivity.primary_saved_vehicle_hours.mean === 0
          ? '같았습니다' : seconds.format(Math.abs(sensitivity.primary_saved_vehicle_hours.mean)) + ' 차량·시간 ' + (sensitivity.primary_saved_vehicle_hours.mean > 0 ? '줄었습니다' : '늘었습니다')}</strong>.
          {sensitivity.primary_saved_vehicle_hours.ci95 && ` 절감량의 95% 신뢰구간은 ${signed(sensitivity.primary_saved_vehicle_hours.ci95[0])} ~ ${signed(sensitivity.primary_saved_vehicle_hours.ci95[1])} 차량·시간입니다. 양수는 절감입니다.`}</p>
        <p>경제성을 판단하려면 현장에서 확인한 시간 절감과 설치·유지관리의 추가 비용이 필요합니다.</p>
      </section>
    </div>}
    <section className="eval-section">
      <h3>세 가지 신호 운영안</h3>
      <div className="eval-table-scroll" tabIndex={0} role="region" aria-label="운영안별 성과표">
        <table><thead><tr><th scope="col">신호 운영</th><th scope="col">평균 대기 (초/대)</th><th scope="col">통과 (대)</th><th scope="col">종료 대기 (대)</th><th scope="col">최대 대기열 (대)</th></tr></thead>
          <tbody>{methods.map(method => { const metric = result.methods[method]; return <tr key={method}>
            <th scope="row"><span className={'eval-key ' + method} />{names[method]}</th><td>{num(metric.wait_s)}</td><td>{num(metric.served)}</td><td>{num(metric.end_queue)}</td><td>{num(metric.peak_queue)}</td>
          </tr> })}</tbody>
        </table>
      </div>
      <p className="eval-note">처음 기다리던 차량을 포함한 실험당 평균 수요는 {num(result.demand_mean)}대입니다. 평균 대기에는 종료 시 줄에 남아 있는 차가 기다린 시간도 포함합니다. 대수는 반복 평균입니다.</p>
    </section>
    <div className="eval-detail-grid">
      <QueueChart result={result} />
      <section className="eval-equity">
        <h3>어느 방향의 대기가 달라졌나</h3>
        <p>시간대별 고정과 자동 배분의 차량당 대기 (초)</p>
        <div className="eval-table-scroll" tabIndex={0} role="region" aria-label="방향별 대기 비교">
          <table><thead><tr><th scope="col">방향</th><th scope="col">시간대별</th><th scope="col">자동</th><th scope="col">차이</th></tr></thead>
            <tbody>{directions.map((phase, i) => {
              const base = result.methods.tod.by_direction[i].wait_s
              const auto = result.methods.adaptive.by_direction[i].wait_s
              const diff = auto === null || base === null ? null : auto - base
              return <tr key={phase}><th scope="row">{phase}</th><td>{num(base)}</td><td>{num(auto)}</td>
                <td className={diff === null || diff === 0 ? '' : diff > 0 ? 'eval-loss' : 'eval-gain'}>{diff === null ? '—' : signed(diff)}</td></tr>
            })}</tbody>
          </table>
        </div>
        <p className="eval-note">양수는 자동 배분에서 더 오래 기다린 방향입니다.</p>
      </section>
    </div>
    <details className="eval-methods" ref={methodsNote}>
      <summary>모형 가정과 현장 검증에 필요한 자료</summary>
      <dl>
        <div><dt>도착과 통과</dt><dd>{inputs.profile === 'surge' ? `전체 ${inputs.cycles}주기 중 ${Math.floor(inputs.cycles / 3) + 1}~${Math.ceil(2 * inputs.cycles / 3)}주기에는 동서 직진 평균 수요를 50% 높입니다. ` : '방향별 평균 수요를 일정하게 유지합니다. '}주기별 수요에 따라 포아송 과정으로 도착 시각을 생성합니다. 계산 간격은 1초입니다. 한 주기는 120초이고, 시작 손실 2초 뒤 직진은 두 차로 합계로 초당 1대, 좌회전은 2초에 1대를 통과시킵니다. 각 현시 뒤 5초는 통과가 없습니다.</dd></div>
        <div><dt>신호계획</dt><dd>동서 직진·좌회전, 남북 직진·좌회전 순으로 기준 고정은 {result.plans.fixed.join(' / ')}초, 시간대별 고정은 {result.plans.tod.join(' / ')}초입니다. 시간대별 고정은 설정한 평균 수요로 한 번 배분합니다. 자동 배분은 이전 주기의 관측으로 다음 신호를 정합니다.</dd></div>
        <div><dt>계산 범위</dt><dd>가상 단일 교차로의 방향별 대기열에 차량을 도착 순서대로 쌓고 녹색시간에 통과시킵니다. 차량의 가감속, 보행자와의 충돌, 인접 교차로까지 이어지는 대기행렬은 별도 검증이 필요합니다.</dd></div>
        <div><dt>불확실성</dt><dd>각 반복에서 세 방식은 같은 도착 차량을 받습니다. 반복별 대기 차이로 계산한 신뢰구간은 이 모형에서 도착 시각이 달라질 때의 변동을 반영합니다. 시흥 현장의 수요나 모형 오차는 별도입니다.</dd></div>
        <div><dt>현장 대조</dt><dd>후보 교차로에서 실제 현시와 녹색시간, 방향별 유입·통과량, 줄 길이, 포화 시 출발 간격을 수집합니다. 일부 날짜로 모형을 보정하고 다른 날짜에 예측한 대기와 줄 길이를 관측값과 대조해야 합니다.</dd></div>
      </dl>
      <p className="eval-note">모형 버전 {result.model_version} · <a href="https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm" target="_blank" rel="noreferrer">FHWA 교통 시뮬레이션 보정 지침</a></p>
    </details>
  </article>
}

export default function EvaluationPanel({ rates, initial, condition, scenarioName }: Props) {
  const [cycles, setCycles] = useState(10)
  const [replications, setReplications] = useState(10)
  const [seedText, setSeedText] = useState('42')
  const [profile, setProfile] = useState<Profile>('steady')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState<{ result: Result; scenario: string } | null>(null)
  const pending = useRef<AbortController | null>(null)
  const seed = Number(seedText)
  const valid = /^\d+$/.test(seedText) && Number.isSafeInteger(seed) && seed <= 2147483647
  const inputs: Inputs = { rates, initial, condition, cycles, replications, seed, profile }
  const firstRun = useRef({ inputs, scenarioName })
  const changed = completed && (inputKey(inputs) !== inputKey(completed.result.inputs) || completed.scenario !== scenarioName || !valid)

  async function run(request: Inputs, scenario: string) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/simulation/evaluate', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error('계산을 완료하지 못했습니다. 입력값과 서버 연결을 확인한 뒤 다시 실행하세요.')
      const result: Result = await response.json()
      if (!controller.signal.aborted) setCompleted({ scenario, result })
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '계산을 완료하지 못했습니다.')
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  useEffect(() => {
    void run(firstRun.current.inputs, firstRun.current.scenarioName)
    return () => { pending.current?.abort() }
  }, [])

  return <section className="card evaluation-panel" aria-label="신호 운영안 반복 실험">
    <div className="eval-intro"><FlaskConical size={22} /><div><h2>신호 운영안 비교 실험</h2>
      <p>가상 교차로의 같은 도착 차량에 세 가지 신호를 적용해, 시간대별 고정 신호를 조정한 뒤에도 자동 배분이 대기를 줄이는지 검토합니다.</p></div></div>
    <div className="eval-controls">
      <label>수요 변화<select className="eval-profile-select" value={profile} onChange={e => setProfile(e.target.value as Profile)}><option value="steady">일정한 평균 수요</option><option value="surge">중간 구간 동서 직진 +50%</option></select></label>
      <label>관찰 시간<select value={cycles} onChange={e => setCycles(Number(e.target.value))}>{[5, 10, 15, 30].map(c => <option key={c} value={c}>{c * 2}분 · {c}주기</option>)}</select></label>
      <label>반복 횟수<select value={replications} onChange={e => setReplications(Number(e.target.value))}>{[5, 10, 20, 30].map(n => <option key={n} value={n}>{n}회</option>)}</select></label>
      <label>난수 시드<input aria-label="난수 시드" inputMode="numeric" value={seedText} onChange={e => setSeedText(e.target.value)} aria-invalid={!valid} /></label>
      <button type="button" disabled={!valid || busy} onClick={() => void run(inputs, scenarioName)}><Play size={16} />{busy ? '실험 실행 중…' : '비교 실험 실행'}</button>
    </div>
    {!valid && <p className="eval-status" role="alert">시드는 0에서 2,147,483,647 사이의 정수를 입력하세요.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {changed && !busy && <p className="eval-status" role="status">조건이 바뀌었습니다. 아래에는 마지막 실행 결과가 표시됩니다. 새 조건은 ‘비교 실험 실행’을 누르면 반영됩니다.</p>}
    {busy && <p className="eval-status" role="status"><ChartNoAxesCombined size={15} />같은 차량 도착 조건에서 세 운영안을 반복 계산하고 있습니다.</p>}
    {completed && <ExperimentResults result={completed.result} scenario={completed.scenario} busy={busy} />}
  </section>
}
