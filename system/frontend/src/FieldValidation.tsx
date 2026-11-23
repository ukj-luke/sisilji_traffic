import { useEffect, useRef, useState } from 'react'
import { Download, FileCheck2, Upload } from 'lucide-react'

const directions = ['동서 직진', '동서 좌회전', '남북 직진', '남북 좌회전']
const header = 'cycle,phase,green_s,start_queue,arrival_times_s,observed_passed,end_queue,cycle_s,green_start_s'
const sample = [header,
  'EXAMPLE-01,1,35,6,1;4;8;14;28;45;70;92;96;114;124,14,3,130,62',
  'EXAMPLE-01,2,22,1,10;20;40;80;103;125.5,5,2,130,103',
  'EXAMPLE-01,3,33,0,4;9;22;32.8;60;90,3,3,130,0',
  'EXAMPLE-01,4,19,1,10;22;45;58;110,4,2,130,38',
].join('\r\n')
type Outcome = {
  timing_source: 'observed_windows' | 'assumed_120s'
  cycles: number; queue_mae: number; direction_mae: number[]; direction_bias: number[]
  rows: {cycle:string; phase:number; observed_end:number; predicted_end:number; observed_passed:number; predicted_passed:number; error:number}[]
}
function normalizeCsv(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], {type}))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function FieldValidation() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState<{name:string; demo:boolean; outcome:Outcome} | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function compare(file?: File) {
    request.current?.abort()
    const ctrl = new AbortController()
    request.current = ctrl
    setBusy(true)
    setReport(null)
    setError('')
    try {
      if (file && file.size > 500000) throw Error('500 KB 이내의 CSV 파일을 선택하세요.')
      const csv = file ? await file.text() : sample
      const response = await fetch('/api/simulation/validate-field', {method:'POST', signal:ctrl.signal,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({csv_text:csv})})
      if (!response.ok) {
        const detail = (await response.json()).detail
        throw Error(typeof detail === 'string' ? detail : 'CSV 열과 입력 범위를 확인하세요.')
      }
      const outcome:Outcome = await response.json()
      const demo = !file || normalizeCsv(csv) === normalizeCsv(sample)
      if (!ctrl.signal.aborted) setReport({name:file?.name ?? '작성 예시', demo, outcome})
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : '대조에 실패했습니다.')
    } finally {
      if (!ctrl.signal.aborted) setBusy(false)
    }
  }
  return <section className="card field-validation">
    <div className="panel-title"><FileCheck2 /><h2>관측한 대기열을 모형이 재현하는지 확인</h2></div>
    <p>실제 도착 시각과 녹색시간으로 한 주기를 재생한 뒤, 정지선에 남은 차량 수를 관측값과 비교합니다. 각 주기는 기록된 초기 대기열에서 독립적으로 시작합니다. 이 오차는 주기 종료 대기열의 재현성을 평가합니다. 자동 배분의 현장 효과는 별도 운영 비교가 필요합니다.</p>
    <div className="field-spec"><strong>적용 조건</strong> 주기 30~300초 · 네 방향에 각각 한 번씩 겹치지 않는 녹색 · 하류 소통 원활. 현장에서 기록한 녹색 시작 시각과 길이로 재생합니다.</div>
    <div className="field-actions">
      <label className="field-upload"><Upload size={16}/> 관측 CSV 선택
        <input type="file" accept=".csv,text/csv" onChange={e => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void compare(file)
        }} />
      </label>
      <button onClick={() => void compare()} disabled={busy}>가상 예시로 대조</button>
      <button onClick={() => download('관측주기_작성예시.csv', '\uFEFF' + sample, 'text/csv;charset=utf-8')}><Download size={15}/> CSV 작성 예시</button>
    </div>
    <details className="field-guide"><summary>관측자료 작성 및 검증 기준</summary>
      <p>한 주기당 네 행을 입력합니다. cycle은 조사일·교차로·주기 식별자입니다. phase의 번호는 1 동서 직진, 2 동서 좌회전, 3 남북 직진, 4 남북 좌회전입니다. 실제 신호 순서는 녹색 시작 시각으로 결정됩니다.</p>
      <p>cycle_s에 주기 길이, green_start_s에 주기 시작부터 녹색이 켜질 때까지의 시간, green_s에 녹색 지속 시간을 정수 초로 입력하세요. 예를 들어 130초 주기의 62초에 켜져 97초에 꺼지면 각각 130, 62, 35입니다. 모든 녹색 구간이 해당 주기 안에 들어와야 합니다.</p>
      <p>기존 7열 양식처럼 cycle_s와 green_start_s를 모두 생략하면 120초 주기, 1→2→3→4 순서, 현시별 전환 5초를 가정합니다. start_queue와 end_queue는 각각 주기 시작과 종료의 대기 대수입니다.</p>
      <p>arrival_times_s에는 모형 대기열에 합류한 차량별 시각을 주기 시작 기준 초로 기록합니다(예: 2.5;10;68). 도착 차량이 없으면 비워 둡니다. observed_passed는 같은 방향의 정지선 통과 대수입니다. 상류 지점의 통과 시각을 그대로 넣으면 이동시간만큼 오차가 생깁니다.</p>
      <p>통과량 계산에는 양방향을 합친 유효 차로 수로 직진 2개·좌회전 1개, 차로당 포화 차두시간 2초, 녹색 시작 후 출발 손실 2초를 사용합니다. 현장 차로 구성과 포화 상태의 통과 간격을 확인한 뒤 오차를 해석하세요.</p>
      <p>시범 대상지에서는 신호 실행 로그, 방향별 차량 궤적과 대기열을 같은 시계로 기록하세요. 보정에 쓴 날짜와 별도 날짜를 나눠 정체·비정체 시간대별 오차를 검토합니다. 허용 오차는 분석 용도에 맞춰 시와 사전에 정합니다. <a href="https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm" target="_blank" rel="noreferrer">FHWA 모형 보정 지침</a></p>
    </details>
    {busy && <p role="status">관측값과 계산값을 대조하고 있습니다.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {report && <div className="field-report">
      <h3>{report.demo ? '가상 예시 대조 결과' : '업로드 자료 대조 결과'} · {report.name}</h3>
      <p>{report.outcome.timing_source === 'observed_windows' ? '입력한 녹색 시작 시각 적용' : '120초 기준 신호 순서 가정'} · {report.outcome.cycles}주기 · 방향당 종료 대기열의 평균 절대오차 <strong>{report.outcome.queue_mae.toFixed(2)}대</strong></p>
      <div className="table-wrap"><table><caption>방향별 종료 대기열 오차</caption>
        <thead><tr><th>방향</th><th>평균 절대오차</th><th>평균 편차 (계산 − 관측)</th></tr></thead>
        <tbody>{directions.map((d,i)=><tr key={d}><th>{d}</th><td>{report.outcome.direction_mae[i].toFixed(2)}대</td><td>{report.outcome.direction_bias[i].toFixed(2)}대</td></tr>)}</tbody>
      </table></div>
      <button onClick={() => download('관측자료_대조결과.json', JSON.stringify(report,null,2), 'application/json')}><Download size={15}/> 주기별 관측·계산값 저장</button>
    </div>}
  </section>
}
