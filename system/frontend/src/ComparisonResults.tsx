import { useMemo, useState } from 'react'
import { ChartNoAxesColumn } from 'lucide-react'
import type { MovementTraces } from './trafficMotion'
import CycleExplanation from './CycleExplanation'
import IntersectionPlayback, { type PlaybackActions } from './IntersectionPlayback'
import './comparison.css'

type Props = {
  traces?: MovementTraces
  playback: PlaybackActions
  phases: string[]
  fixed: number[]
  auto: number[]
  fixedStart: number[]
  autoStart: number[]
  fixedGreen: number[]
  autoGreen: number[]
  hourlyRates: number[]
  condition: string
  cycle: number
}

const count = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 })

export default function ComparisonResults({
  phases, fixed, auto, fixedStart, autoStart, fixedGreen, autoGreen,
  hourlyRates, condition, cycle, playback, traces,
}: Props) {
  const [direction, setDirection] = useState(0)
  const [speed, setSpeed] = useState(4)
  const motion = useMemo(() => ({
    fixedStart, autoStart, fixedGreen, autoGreen, fixedEnd: fixed, autoEnd: auto, hourlyRates, traces,
  }), [fixedStart, autoStart, fixedGreen, autoGreen, fixed, auto, hourlyRates, traces])
  const methods = [
    { key: 'fixed', name: '고정 신호', queues: fixed },
    { key: 'auto', name: '자동 배분', queues: auto },
  ]
  const scale = Math.max(1, ...fixed, ...auto)
  return (
    <section className="card comparison-results" aria-labelledby="comparison-title">
      <header className="panel-head">
        <div className="panel-title">
          <ChartNoAxesColumn aria-hidden="true" />
          <h2 id="comparison-title">교차로 움직임 비교</h2>
        </div>
        <span className="comparison-cycle">
          {cycle === 0 ? '시작 전' : `${cycle}번째 주기`}
        </span>
      </header>
      <div className="comparison-content">
        <div className="comparison-toolbar">
          <label className="comparison-direction">
          살펴볼 방향
          <select value={direction} onChange={e => setDirection(Number(e.target.value))}>
            {phases.map((phase, i) => <option key={phase} value={i}>{phase}</option>)}
          </select>
          </label>
        </div>
        <IntersectionPlayback key={cycle} motion={motion} phases={phases} direction={direction}
          cycle={cycle} speed={speed} setSpeed={setSpeed} {...playback} />
        {cycle <= 1 && <p className="comparison-note">첫 주기는 두 방식 모두 기준 신호로 출발합니다. 자동 배분은 한 주기의 유입과 대기열을 관측한 뒤 다음 주기부터 녹색시간을 조정합니다. 유입량을 유지하면 일정 수요·시드 42 실험의 첫 번째 반복과 같은 결과를 재현합니다.</p>}
        <h3>{cycle ? cycle + '주기 종료 결과' : '시작 조건'}</h3>
        <CycleExplanation
          phase={phases[direction]}
          cycle={cycle}
          arrivals={traces?.arrivals[direction].length ?? hourlyRates[direction] / 30}
          fixed={{ start: fixedStart[direction], green: fixedGreen[direction], end: fixed[direction] }}
          auto={{ start: autoStart[direction], green: autoGreen[direction], end: auto[direction] }}
          condition={condition}
        />
        <h3>{cycle === 0 ? '네 방향을 합친 시작 대기 차량' : '네 방향을 합쳐 남은 차량'}</h3>
        <dl className="comparison-totals" aria-live="polite" aria-atomic="true">
          {methods.map(({ key, name, queues }) => (
            <div key={key} className={`comparison-method comparison-${key}`}>
              <dt>{name}</dt>
              <dd>
                {count.format(queues.reduce((sum, value) => sum + value, 0))}
                <small>대</small>
              </dd>
            </div>
          ))}
        </dl>
        <table className="comparison-table">
          <caption>{cycle === 0 ? '방향별로 기다리는 차' : '방향별로 다음 신호를 기다리는 차'}</caption>
          <thead>
            <tr>
              <th scope="col">이동 방향</th>
              {methods.map(({ key, name }) => <th key={key} scope="col">{name}</th>)}
            </tr>
          </thead>
          <tbody>
            {phases.map((phase, i) => (
              <tr key={phase}>
                <th scope="row">{phase}</th>
                {methods.map(({ key, queues }) => (
                  <td key={key} className={`comparison-${key}`}>
                    <span className="comparison-number">{count.format(queues[i])}대</span>
                    <div className="comparison-track" aria-hidden="true">
                      <span style={{ width: `${queues[i] / scale * 100}%` }} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="comparison-note">차량 수는 가상 교차로에서 계산한 추정값입니다.</p>
      </div>
    </section>
  )
}
