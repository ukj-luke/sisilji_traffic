import './cycle-explanation.css'

type DirectionResult = { start: number; green: number; end: number }
type Props = {
  phase: string
  cycle: number
  arrivals: number
  fixed: DirectionResult
  auto: DirectionResult
  condition: string
}

const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 })
const cars = (value: number) => format.format(value) + '대'

export default function CycleExplanation({ phase, cycle, arrivals, fixed, auto, condition }: Props) {
  if (cycle === 0) {
    return (
      <div className="cycle-explanation cycle-preview">
        <p><strong>{phase}</strong> 방향에 <b>{cars(fixed.start)}</b>가 기다리고 있어요.
          {' '}설정한 교통량에서 2분 동안 예상되는 평균 도착 차량은 <b>{cars(arrivals)}</b>입니다.</p>
        <p>첫 주기에는 두 방식이 같은 신호로 출발합니다. 자동 배분은 관측한 수요를 다음 주기 신호에 반영합니다.</p>
      </div>
    )
  }

  const difference = auto.end - fixed.end
  const outcome = difference === 0
    ? `두 방식 모두 ${cars(fixed.end)}가 남았어요.`
    : `자동 배분에서 ${cars(Math.abs(difference))} ${difference < 0 ? '적게' : '더'} 남았어요.`
  const methods = [
    { name: '고정 신호', result: fixed, className: 'cycle-fixed' },
    { name: '자동 배분', result: auto, className: 'cycle-auto' },
  ]
  return (
    <div className="cycle-explanation">
      <p className="cycle-outcome"><strong>{phase}</strong> 방향에는 {outcome}</p>
      <div className="cycle-ledgers">
        {methods.map(({ name, result, className }) => (
          <section key={name} className={className} aria-label={name + ' 계산 내역'}>
            <h4>{name}<span>녹색 {result.green}초</span></h4>
            <dl>
              <div><dt>처음 기다린 차</dt><dd>{cars(result.start)}</dd></div>
              <div><dt>들어온 차</dt><dd>+{cars(arrivals)}</dd></div>
              <div><dt>통과한 차</dt><dd>−{cars(result.start + arrivals - result.end)}</dd></div>
              <div className="cycle-balance"><dt>남은 차</dt><dd>{cars(result.end)}</dd></div>
            </dl>
          </section>
        ))}
      </div>
      {cycle === 1 && <p className="cycle-context">첫 주기는 같은 신호계획으로 관측했습니다. ‘다음 주기’에서 관측 결과가 신호 배분에 어떻게 반영되는지 확인하세요.</p>}
      {phase === '동서 직진' && condition === 'blocked' && (
        <p className="cycle-context">교차로 너머 도로가 막혀 있어 초록불이 켜져도 이 방향 차량은 통과할 수 없어요.</p>
      )}
      {condition === 'missing' && (
        <p className="cycle-context">동서 직진 측정값이 누락되면 자동 배분은 기준 신호계획을 목표로 다음 주기의 녹색시간을 계산합니다.</p>
      )}
    </div>
  )
}
