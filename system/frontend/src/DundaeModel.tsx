import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import results from '../../data/dundae-results.json'
import './dundae-model.css'

type Scenario = 'A' | 'B' | 'C' | 'D'
type Method = 'fixed' | 'adaptive'
type Metric = 'endQueue' | 'meanQueue' | 'served'

interface Arm {
  startQueue: number
  arrivals: number
  served: number
  endQueue: number
  meanQueue: number
  endQueueByCode: Record<string, number>
  cycleEndQueue: number[]
  cycleServed: number[]
  cycleEndByCode: number[][]
  cycleGreens: number[][]
}
interface Exceedance { code: string; quarter: number; count: number; capacity: number }
interface ModelCase {
  capacityCheck: {
    slotsPerQuarterByCode: Record<string, number>
    warmExceedances: Exceedance[]
    peakExceedances: Exceedance[]
    peakExcessVehicles: number
  }
  phaseCodes: number[][]
  lanesByCode: Record<string, number>
  fixed: Arm
  adaptive: Arm
  paired: Record<Metric, { mean: number; ci95: number[]; n: number }>
  checks: { maxAbsConservationError: number }
}
interface Results {
  assumptions: {
    codeOrder: string[]
    cycleSeconds: number
    startupSeconds: number
    saturationHeadwaySecondsPerLane: number
    greenChangeLimitSeconds: number
    seeds: number[]
  }
  scenarios: Record<Scenario, ModelCase>
}

const model: Results = results
const choices: Scenario[] = ['D', 'A', 'B', 'C']
const choiceTitles = { A: '기본 가정', B: '현시 배정 변경', C: '차로 수 변경', D: '직전 시간으로 추정' }
const descriptions = {
  D: 'A의 현시 배정을 유지하고, 07~08시의 모든 15분 관측값을 처리할 수 있는 코드별 최소 정수 차로 수를 구했습니다. 이 환산값은 고정 신호의 처리용량을 나타냅니다.',
  A: '코드 2·8에 각 4차로를 부여하고, 두 코드를 2현시에 함께 배정했습니다.',
  B: 'A의 차로 수를 유지하고 2현시와 4현시에 배정한 코드 묶음을 맞바꿨습니다.',
  C: 'A의 현시 배정을 유지하고 코드 2·8의 차로를 각각 4개에서 3개로 줄였습니다.',
}
const metrics: [Metric, string][] = [['endQueue', '09:00 잔류'], ['meanQueue', '시간 평균 대기'], ['served', '1시간 통과']]
const amt = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const format = (value: number) => amt.format(Math.abs(value) < .05 ? 0 : value)
function signed(value: number) { return (value >= .05 ? '+' : '') + format(value) }
function clock(cycle: number) {
  const minutes = 8 * 60 + cycle * model.assumptions.cycleSeconds / 60
  return [Math.floor(minutes / 60), minutes % 60].map(n => String(n).padStart(2, '0')).join(':')
}

function Trend({ item, step }: { item: ModelCase; step: number }) {
  const methods: Method[] = ['fixed', 'adaptive']
  const series = { fixed: [item.fixed.startQueue, ...item.fixed.cycleEndQueue], adaptive: [item.adaptive.startQueue, ...item.adaptive.cycleEndQueue] }
  const last = series.fixed.length - 1
  const highest = Math.max(1, ...series.fixed, ...series.adaptive)
  const unit = 10 ** Math.floor(Math.log10(highest))
  const ceiling = Math.ceil(highest / unit) * unit
  const x = (i: number) => 66 + 552 * i / last
  const y = (value: number) => 143 - value / ceiling * 119
  return <svg className="dm-trend" viewBox="0 0 635 170" role="img" aria-label="08시부터 09시까지 두 방식의 주기 종료 대기 차량 추이. 선택 시각의 수치는 아래에 표시됩니다.">
    {[0, ceiling / 2, ceiling].map(tick => <g key={tick}>
      <line className="dm-grid" x1={x(0)} x2={x(last)} y1={y(tick)} y2={y(tick)} />
      <text x={x(0) - 9} y={y(tick) + 4} textAnchor="end">{tick.toLocaleString('ko-KR')}</text>
    </g>)}
    {[0, last / 2, last].map(i => <text key={i} x={x(i)} y="165" textAnchor={i === last ? 'end' : i === 0 ? 'start' : 'middle'}>{clock(i)}</text>)}
    <line className="dm-cursor" x1={x(step)} x2={x(step)} y1="12" y2={y(0)} />
    {methods.map(method => <polyline key={method} className={`dm-line dm-${method}`} points={series[method].map((v, i) => x(i) + ',' + y(v)).join(' ')} />)}
    {methods.map(method => <circle className={`dm-point dm-${method}`} key={method} cx={x(step)} cy={y(series[method][step])} r={method === 'fixed' ? 6 : 3.5} />)}
  </svg>
}

export default function DundaeModel() {
  const [scenario, setScenario] = useState<Scenario>('D')
  const [cycle, setCycle] = useState(model.scenarios.A.fixed.cycleEndQueue.length)
  const item = model.scenarios[scenario]
  const totalCycles = item.fixed.cycleEndQueue.length
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const tick = window.setTimeout(() => {
      if (cycle < totalCycles) setCycle(cycle + 1)
      if (cycle >= totalCycles - 1) setPlaying(false)
    }, 800)
    return () => window.clearTimeout(tick)
  }, [cycle, playing, totalCycles])
  function seek(next: number) {
    setPlaying(false)
    setCycle(next)
  }
  function togglePlay() {
    if (!playing && cycle === totalCycles) setCycle(1)
    setPlaying(!playing)
  }
  const i = cycle - 1
  const codes = model.assumptions.codeOrder
  const fixed = item.fixed.cycleEndByCode[i]
  const adaptive = item.adaptive.cycleEndByCode[i]
  const maxByCode = Math.max(1, ...item.fixed.cycleEndByCode.flat(), ...item.adaptive.cycleEndByCode.flat())
  const time = clock(cycle)
  const difference = item.paired.endQueue
  const crossesZero = difference.ci95[0] <= 0 && difference.ci95[1] >= 0
  const check = item.capacityCheck
  const largest = check.peakExceedances.reduce<Exceedance | undefined>((worst, row) =>
    !worst || row.count - row.capacity > worst.count - worst.capacity ? row : worst, undefined)
  return <section className="card dm-panel" aria-labelledby="dm-title">
    <header className="dm-head"><h2 id="dm-title">고정 신호와 자동 배분 비교</h2>
      <p>두 방식에 같은 차량을 같은 시각에 투입했습니다. 아래의 대기·통과 대수는 모형을 {model.assumptions.seeds.length}회 반복한 평균입니다.</p>
    </header>
    <div role="group" aria-label="가정 시나리오" className="dm-choices">
      {choices.map(key => <button type="button" key={key} aria-pressed={key === scenario} onClick={() => { setPlaying(false); setScenario(key) }}><span>{key}</span>{choiceTitles[key]}</button>)}
    </div>
    <p className="dm-case-copy"><strong>가정 {scenario}</strong> {descriptions[scenario]} 현장의 실제 차로 수와 코드별 현시 배정은 미확인입니다.</p>
    <div className="dm-outcome">
      <div><span>가정 {scenario} · 09:00 모형 잔류 차량 차이</span><strong>{format(Math.abs(difference.mean))}대 {difference.mean < 0 ? '감소' : difference.mean > 0 ? '증가' : '차이'}</strong></div>
      <p>가정 {scenario}의 고정 신호 {format(item.fixed.endQueue)}대, 자동 배분 {format(item.adaptive.endQueue)}대입니다. {crossesZero ? '평균 차이의 95% 구간에 0이 포함됩니다.' : '같은 시각의 고정 신호를 기준으로 비교했습니다.'}</p>
    </div>
    <p className="dm-sensitivity"><strong>현시 배정만 바꿔도 결과가 뒤집힙니다.</strong> 자동 배분의 09시 잔류 차량이 A에서는 {format(model.scenarios.A.paired.endQueue.mean)}대 증가하고 B에서는 {format(-model.scenarios.B.paired.endQueue.mean)}대 감소했습니다. 실제 허용 이동류와 대기행렬을 대조해야 현장 개선 효과를 판단할 수 있습니다.</p>
    <div className="dm-validation">
      <h3>관측 교통량과 고정 신호 처리용량</h3>
      <p>08~09시의 <strong>48개 관측값 중 {check.peakExceedances.length}개</strong>가 해당 방향의 15분 이론 최대 통과 대수를 넘었습니다. 07~08시에는 48개 중 {check.warmExceedances.length}개가 초과했습니다.</p>
      {largest && <p>가장 큰 차이는 코드 {largest.code}, {clock(largest.quarter * 5)}~{clock((largest.quarter + 1) * 5)}의 <strong>{largest.count}대 관측 / 최대 {largest.capacity}대</strong>입니다.</p>}
      <p>최대치는 녹색 동안 차량이 계속 대기한다고 가정한 값입니다. 현장 대기행렬과 자동 배분 효과는 미검증입니다.</p>
    </div>
    <div className="dm-metric-scroll"><table className="dm-metrics">
      <caption>08:00~09:00 모형 결과 <span>단위 대</span></caption>
      <thead><tr><th scope="col">비교 지표</th><th scope="col" className="dm-fixed-text">고정 신호</th><th scope="col" className="dm-auto-text">자동 배분</th><th scope="col">자동 − 고정</th><th scope="col">차이의 95% 신뢰구간</th></tr></thead>
      <tbody><tr><th scope="row">08:00 시작 대기</th><td>{format(item.fixed.startQueue)}</td><td>{format(item.adaptive.startQueue)}</td><td>0.0</td><td>공통 시작값</td></tr>
      {metrics.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{format(item.fixed[key])}</td><td>{format(item.adaptive[key])}</td><td><strong>{signed(item.paired[key].mean)}</strong></td><td>{item.paired[key].ci95.map(signed).join(' ~ ')}</td></tr>)}
      </tbody>
    </table></div>
    <p className="dm-note">08:00 시작 대기는 07시부터 고정 신호로 계산한 값입니다. 95% 구간은 15분 안의 도착 시각을 바꾸어 반복했을 때 생기는 평균 차이의 불확실성만 반영합니다.</p>
    <div className="dm-heading"><h3>주기별 대기 차량</h3><div className="dm-legend"><span><i className="dm-legend-fixed" />고정 신호</span><span><i className="dm-legend-auto" />자동 배분</span></div></div>
    <div className="dm-cycle-panel">
      <Trend item={item} step={cycle} />
      <div className="dm-timeline">
        <button type="button" className="dm-play" onClick={togglePlay} aria-pressed={playing} aria-label={playing ? '주기 재생 일시정지' : '주기별 자동 재생'}>{playing ? <Pause size={15}/> : <Play size={15}/>}<span>{playing ? '정지' : '재생'}</span></button>
        <button type="button" aria-label="이전 주기" disabled={cycle === 1} onClick={() => seek(cycle - 1)}><ChevronLeft size={18} /></button>
        <label><span>선택한 시각 <strong>{time}</strong></span>
          <input type="range" min="1" max={totalCycles} value={cycle} aria-label="비교할 주기 종료 시각" aria-valuetext={`${time}, ${cycle}주기 종료`} onChange={e => seek(Number(e.target.value))} />
        </label>
        <button type="button" aria-label="다음 주기" disabled={cycle === totalCycles} onClick={() => seek(cycle + 1)}><ChevronRight size={18} /></button>
      </div>
      <div className="dm-cycle-totals">
        <span>{cycle} / {totalCycles}주기 종료</span><span>고정 <b className="dm-fixed-text">{format(item.fixed.cycleEndQueue[i])}대</b></span><span>자동 <b className="dm-auto-text">{format(item.adaptive.cycleEndQueue[i])}대</b></span>
      </div>
    </div>
    <div className="dm-heading"><h3>{time} 방향별 잔류 대수</h3></div>
    <p className="dm-note">코드 1~12는 원표의 진행방향 번호입니다. 방위·회전명은 미확인입니다. 두 막대는 같은 눈금을 사용합니다.</p>
    <div className="dm-code-grid">
      {codes.map((code, index) => <div className="dm-code" key={code}>
        <strong>코드 {code}</strong>
        {([['fixed', '고정', fixed[index]], ['adaptive', '자동', adaptive[index]]] as const).map(([method, name, value]) =>
          <div key={method} className={`dm-code-row dm-${method}`}><span>{name}</span><i aria-hidden="true"><em style={{ width: (100 * value / maxByCode) + '%' }} /></i><b>{format(value)}대</b></div>
        )}
      </div>)}
    </div>
    <details className="dm-details dm-methods"><summary>계산 조건</summary>
      <dl>
        <div><dt>초기 대기</dt><dd>07:00 대기 0대에서 시작해 1시간 동안 고정 신호로 계산했습니다. 각 반복에서 두 방식은 같은 08:00 대기열로 출발하고 09:00에 집계를 종료합니다.</dd></div>
        <div><dt>차량 도착</dt><dd>원표의 코드별 15분 통과 대수를 도착 대수로 대입했습니다. 매 구간 안에서는 도착 시각을 독립적인 균등분포로 뽑고, 두 방식에 동일하게 적용했습니다.</dd></div>
        <div><dt>신호 운영</dt><dd>주기는 {model.assumptions.cycleSeconds}초, 황색은 매 현시 3초, 별도 전적색은 0초로 고정했습니다. 자동 배분은 직전 주기의 도착·잔류량을 보고 다음 주기의 녹색시간을 정합니다. 각 현시는 기준 녹색시간의 ±{model.assumptions.greenChangeLimitSeconds}초 안에서 조정합니다.</dd></div>
        <div><dt>대기와 통과</dt><dd>각 방향 코드는 독립적인 선입선출 대기열을 사용합니다. 차로 공유와 다른 대기열의 차단 효과는 계산에서 제외했습니다. 녹색 시작 후 {model.assumptions.startupSeconds}초의 출발 손실을 두고, 차량 종류에 관계없이 차로당 {model.assumptions.saturationHeadwaySecondsPerLane}초에 1대가 통과할 수 있다고 가정했습니다.</dd></div>
      </dl>
    </details>
    <details className="dm-details"><summary>선택 주기의 현시별 녹색시간과 차로 가정</summary>
      <p className="dm-note">괄호 안은 코드별 가정 차로 수입니다. 녹색시간은 해당 주기 반복 평균입니다.</p>
      <div className="dm-metric-scroll"><table className="dm-phase-table"><thead><tr><th scope="col">현시</th><th scope="col">진행방향 코드 (차로)</th><th scope="col">고정 신호</th><th scope="col">자동 배분</th></tr></thead>
        <tbody>{item.phaseCodes.map((group, phase) => <tr key={phase}><th scope="row">{phase + 1}현시</th><td>{group.map(code => `${code} (${item.lanesByCode[code]})`).join(' · ')}</td><td>{format(item.fixed.cycleGreens[i][phase])}초</td><td>{format(item.adaptive.cycleGreens[i][phase])}초</td></tr>)}</tbody></table></div>
    </details>
  </section>
}
