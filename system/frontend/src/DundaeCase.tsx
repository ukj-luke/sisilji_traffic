import { useState } from 'react'
import { ArrowDown, ArrowUpRight, Download, MapPin } from 'lucide-react'
import survey from '../../data/dundae-survey.json'
import results from '../../data/dundae-results.json'
import DundaeModel from './DundaeModel'
import './dundae.css'

const digits = new Intl.NumberFormat('ko-KR')
const number = (value: number) => digits.format(value)
const sum = (values: number[]) => values.reduce((total, next) => total + next, 0)
const peak = survey.hourly['08:00']
const warm = survey.hourly['07:00']
const fieldCheck = survey.fieldVerification
const hours = Object.keys(survey.hourly) as (keyof typeof survey.hourly)[]
const codes = Object.keys(peak.quarterCountsByDirection) as (keyof typeof peak.quarterCountsByDirection)[]
const peakTotal = peak.totalVehicles
const greenTotal = sum(survey.greenSeconds)
const yellowTotal = sum(survey.yellowSeconds)
const mainCodes = [...codes].sort((a,b) => sum(peak.quarterCountsByDirection[b]) - sum(peak.quarterCountsByDirection[a])).slice(0, 2)
const topShare = mainCodes.reduce((total, code) => total + sum(peak.quarterCountsByDirection[code]), 0) * 100 / peakTotal

function saveFile(filename: string, payload: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([payload], {type}))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function saveCounts() {
  const lines = [['조사일', '교차로', '기하구조ID', '시작시각', '방향코드', ...survey.classOrder, '합계'].join(',')]
  for (const hour of hours) {
    const measured = survey.hourly[hour]
    for (const code of codes) {
      measured.classCountsByDirection[code].forEach((classes, quarter) => {
        const minute = String(quarter * 15).padStart(2, '0')
        lines.push([survey.surveyDate, survey.site, survey.geometryId, hour.slice(0, 3) + minute,
          code, ...classes, measured.quarterCountsByDirection[code][quarter]].join(','))
      })
    }
  }
  saveFile('둔대교차로_20240329_방향차종별_15분통행량.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8')
}

function External({href, children}: {href: string; children: React.ReactNode}) {
  return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true"/></a>
}

function SurveyTable() {
  const [hour, setHour] = useState<keyof typeof survey.hourly>('08:00')
  const data = survey.hourly[hour]
  const top = Math.max(...Object.values(data.quarterCountsByDirection).flat())
  const times = survey.quarterStartMinutes.map(minute => hour.slice(0,3) + String(minute).padStart(2,'0'))
  return <section className="dc-block card">
    <div className="dc-heading"><div><h3>어느 방향에 차량이 몰렸나</h3>
      <p>교통량 원표의 방향 번호별 15분 통과 대수입니다. 색이 진할수록 선택한 시간대의 통과량이 많습니다.</p></div>
      <label className="dc-select">조사 시간대
        <select value={hour} onChange={e=>setHour(e.target.value as keyof typeof survey.hourly)}>
          {hours.map(h=><option key={h} value={h}>{h} ~ {String(Number(h.slice(0,2))+1).padStart(2,'0')}:00</option>)}
        </select>
      </label>
    </div>
    <div className="dc-flow-layout">
      <div className="dc-table-box"><table className="dc-table dc-heat">
        <caption>방향별 통과량 <span>단위 대 · 각 열은 시작 시각부터 15분</span></caption>
        <thead><tr><th scope="col">방향 코드</th>{times.map(t=><th key={t} scope="col">{t}</th>)}<th scope="col">1시간</th></tr></thead>
        <tbody>{codes.map(code=><tr key={code}>
          <th scope="row">{String(code).padStart(2, '0')}</th>
          {data.quarterCountsByDirection[code].map((count,i)=><td key={i} style={{backgroundColor:`color-mix(in srgb, var(--brand) ${count ? 3 + count / top * 33 : 0}%, transparent)`}}>{number(count)}</td>)}
          <td>{number(sum(data.quarterCountsByDirection[code]))}</td>
        </tr>)}</tbody><tfoot><tr><th scope="row">전체</th>{data.quarterTotals.map((n,i)=><td key={i}>{number(n)}</td>)}<td>{number(data.totalVehicles)}</td></tr></tfoot>
      </table></div>
      <div className="dc-flow-aside">
        <figure><figcaption>차종별 통과 대수</figcaption><p>{hour}부터 1시간 · 전체 {number(data.totalVehicles)}대</p>
          {survey.classOrder.map((type,i)=>{
            const count = codes.reduce((n, code)=>n+sum(data.classCountsByDirection[code].map(row=>row[i])),0)
            return <div key={type} className="dc-class-row"><span>{type}</span><div aria-hidden="true"><i style={{width:count*100/data.totalVehicles+'%'}}/></div><strong>{number(count)}대</strong></div>
          })}
        </figure>
        <p>방향 8과 방향 2가 오전 8~9시 통과량의 <strong>{topShare.toFixed(1)}%</strong>를 차지했습니다. 이 번호를 실제 접근로나 회전 방향에 연결하려면 조사 당시의 방향도가 필요합니다.</p>
        <External href={survey.sources.allVolumes}>6개 시간대 교통량 원표</External>
      </div>
    </div>
  </section>
}

export default function DundaeCase() {
  function go(id: string) {
    document.getElementById(id)?.scrollIntoView({block:'start'})
    document.getElementById(id)?.focus({preventScroll:true})
  }
  return <div className="dc-case" aria-label="둔대교차로 실측 사례">
    <header className="dc-hero">
      <div className="dc-kicker"><MapPin size={15}/> 경기 시흥시 · 교통영향평가 현장 조사</div>
      <h2>둔대교차로의 출근 한 시간</h2>
      <p>2024년 3월 29일 오전 8시부터 9시까지, 같은 교차로에서 조사한 신호시간과 방향별 통과량으로 두 운영안을 비교했습니다.</p>
      <div className="dc-hero-metrics">
        <div><span>조사된 통과량</span><strong>{number(peakTotal)}<small>대</small></strong></div>
        <div><span>분석 주기 · 녹색과 황색의 합</span><strong>{greenTotal+yellowTotal}<small>초</small></strong></div>
        <div><span>조사 방향 × 15분 구간</span><strong>12 <small>×</small> 4</strong></div>
      </div>
    </header>
    <nav className="dc-jumps" aria-label="둔대 사례 세부 내용">
      <button onClick={()=>go('dc-comparison')}><ArrowDown size={15}/> 고정·자동 비교 결과</button>
      <button onClick={()=>go('dc-observation')}>신호·교통량 실측표</button>
      <button onClick={()=>go('dc-evidence')}>실제 대기열 대조</button>
    </nav>
    <section id="dc-comparison" tabIndex={-1} aria-label="고정 신호와 자동 배분 모형 비교"><DundaeModel/></section>
    <section id="dc-observation" tabIndex={-1} className="dc-block card">
      <div className="dc-heading"><div><h3>녹색과 황색은 얼마나 이어졌나</h3>
        <p>오전 7~8시와 8~9시 조사표에 동일한 다섯 현시가 기록됐습니다. 한 현시는 같은 신호 조합이 유지되는 구간입니다.</p></div>
        <External href={survey.sources.signals}>신호 조사 원표</External>
      </div>
      <div className="dc-signal" aria-hidden="true">{survey.greenSeconds.map((g,i)=><div key={i} style={{flexGrow:g+survey.yellowSeconds[i]}}>
        <span style={{flexGrow:g}}>현시 {i+1}</span><i style={{flexGrow:survey.yellowSeconds[i]}}/></div>)}</div>
      <div className="dc-signal-key">{survey.greenSeconds.map((g,i)=><div key={i}><span>{i+1}현시</span><b>녹색 {g}초</b> · 황색 {survey.yellowSeconds[i]}초</div>)}</div>
      <p className="dc-foot">녹색 합 {greenTotal}초 + 황색 합 {yellowTotal}초 = {greenTotal+yellowTotal}초. 실험에서는 별도 전적색을 0초로 두고 1현시에서 시작합니다. 조사표에는 모든 방향이 적색인 별도 시간과 이웃 교차로와의 신호 시차가 기재되지 않았습니다.</p>
    </section>
    <SurveyTable/>
    <section id="dc-evidence" tabIndex={-1} className="dc-block card">
      <div className="dc-heading"><div><h3>실제 대기열과 얼마나 맞았나</h3><p>{survey.project} · 기하구조 ID {survey.geometryId}</p></div></div>
      <div className="dc-table-box"><table className="dc-table">
        <caption>09:00 교차로 전체 잔류 차량 <span>2024년 3월 29일 · 기본 표시 가정 D · 20회 평균</span></caption>
        <thead><tr><th scope="col">실제 관측</th><th scope="col">고정 신호 모형</th><th scope="col">자동 배분 모형</th><th scope="col">고정 신호의 관측 오차</th></tr></thead>
        <tbody><tr><th scope="row">관측값 미확보</th><td>{results.scenarios.D.fixed.endQueue.toLocaleString('ko-KR',{maximumFractionDigits:2})}대</td><td>{results.scenarios.D.adaptive.endQueue.toLocaleString('ko-KR',{maximumFractionDigits:2})}대</td><td>산출 불가</td></tr></tbody>
      </table></div>
      <p>같은 시각과 방향으로 모형과 짝지을 수 있는 대기열 관측은 {fieldCheck.timedQueueObservationsMatched}건입니다. 통과 대수만으로는 새로 도착한 차와 그 전에 기다리던 차를 구분할 수 없습니다. 녹색이 끝날 때의 잔류와 전체 신호주기가 끝날 때의 대기는 각각 같은 시점의 관측과 비교해야 합니다.</p>
      <ul className="dc-field-sources">
        <li><strong>진행 방향</strong>　{fieldCheck.routeDescription} <External href={fieldCheck.sources.routes}>시흥도시공사 길 안내</External> · <External href={survey.sources.signals}>조사일 현시표</External></li>
        <li><strong>영상 확인</strong>　2026년 11월 23일 01:26에 경기도 공식 플레이어에서 둔대교차로 영상을 확인했습니다. {fieldCheck.cameraObservation} <External href={fieldCheck.sources.camera}>둔대교차로 CCTV</External></li>
        <li><strong>조사 원자료 소재</strong>　시흥시 체육진흥과 감독 용역의 납품목록에 최종보고서, 기본계획 도면집, 현황조사 자료 및 사진첩이 명시돼 있습니다. 주기별 실제 잔류 대수의 조사·보관 여부는 공개목록에서 확인되지 않았습니다. <External href={fieldCheck.sources.scopeOfWork}>과업지시서가 첨부된 공고</External> · <External href={fieldCheck.sources.contract}>시흥시 계약 기록</External></li>
      </ul>
      <dl className="dc-proof">
        <div><dt>원표와 대조 완료</dt><dd>같은 날짜·교차로의 방향별 15분 통과량, 6개 차종의 합계, 현시별 녹색·황색 시간입니다. 오전 7~8시 {number(warm.totalVehicles)}대와 8~9시 {number(peakTotal)}대를 각각 대조했습니다.</dd></div>
        <div><dt>모형 안에서 검산</dt><dd>두 운영안에 방향별로 같은 수의 차량을 같은 시각에 투입하고, 매 주기 시작 대기와 도착의 합이 통과와 종료 대기의 합과 일치하는지 검사했습니다. 포화 상태의 최대 처리량도 실제 15분 통과량과 대조했습니다.</dd></div>
        <div><dt>현장 확인 필요</dt><dd>방향 번호의 방위·회전, 현시별 허용 이동류, 실차로·공용차로, 보행 및 우회전 처리, 포화 차두시간, 초단위 도착, 실제 대기열과 지체시간입니다. 조사된 통과량을 도착 수요로 대입했으므로 현장 대기행렬 오차와 운영 개선율은 산정할 수 없습니다.</dd></div>
      </dl>
      <p className="dc-next">현장 재현성을 판단하려면 조사 당시 방향도와 신호 운영도를 먼저 맞춘 뒤, 같은 시각의 정지선 통과·대기열 관측으로 모형을 검증해야 합니다. 조사 뒤 시흥시는 둔대~관곡 구간의 왕복 8차로 전 구간 개통을 2024년 7월 1일로 예고했습니다. 현재 운영을 평가하려면 확장 이후 자료가 필요합니다. <External href="https://www.siheung.go.kr/media/bbs/view.do?bIdx=165605&amp;ptIdx=82&amp;mId=0100000000">시흥시 도로시설과 공지</External></p>
      <details className="dc-disclosure"><summary>같은 사업에서 검토한 교차로 3곳</summary>
        <p>둔대는 12개 방향 모두에 통행 기록이 있고 직전 시간까지 연속으로 재생할 수 있는 신호교차로입니다.</p>
        <div className="dc-table-box"><table className="dc-table"><caption>2024년 3월 29일 08~09시</caption><thead><tr><th>교차로</th><th>형태</th><th>통과량</th><th>녹색+황색</th><th>원표</th></tr></thead>
          <tbody>{survey.candidates.map(c=><tr key={c.site}><th scope="row">{c.site}</th><td>{c.legs} · {c.control}</td><td>{c.total===null?'자료 행 미확인':number(c.total)+'대'}</td><td>{c.sumOfListedSeconds===null?'해당 없음':c.sumOfListedSeconds+'초'}</td><td><External href={c.sources.volume}>통행량</External> <External href={c.sources.phase}>현시</External></td></tr>)}</tbody>
        </table></div>
      </details>
      <div className="dc-sources"><External href={survey.sources.project}>사업 개요</External><External href={survey.sources.peakVolumes}>첨두시간 원표</External><External href={survey.sources.geometryCsvCatalog}>기하구조 데이터</External><External href={survey.sources.reportIndex}>사업 보고서 목록</External></div>
      <div className="dc-download"><button onClick={saveCounts}><Download size={15}/> 15분 통행량 CSV</button><button onClick={()=>saveFile('둔대교차로_입력및결과.json',JSON.stringify({survey,results},null,2),'application/json')}><Download size={15}/> 실험 입력·결과 JSON</button></div>
    </section>
  </div>
}
