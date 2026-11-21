import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  BookOpen,
  Cctv,
  ChevronRight,
  CircleHelp,
  Clock3,
  FlaskConical,
  LayoutDashboard,
  List,
  MapPin,
  MapPinned,
  Network,
  RadioTower,
  Route,
  Search,
  SlidersHorizontal,
  Waypoints,
} from 'lucide-react'
import { Dialog, SiteDialog } from './Dialogs'
import { MapPanel } from './MapPanel'
import { Simulation } from './Simulation'
import { districts, displayName, siteNumber, type Intersection } from './types'
import './style.css'

const preference = [
  '스마트_16',
  '스마트_14',
  '스마트_52',
  '스마트_31',
  '스마트_53',
]
const sortKey = (site: Intersection) => {
  const i = preference.indexOf(site.id)
  return i < 0 ? 99 : i
}
const dateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="clock" aria-label="한국 표준시">
      <Clock3 size={15} />
      <span>
        {dateFormat.format(now).replaceAll(' ', '').replace(/\.$/, '')}
      </span>
      <b>{timeFormat.format(now)}</b>
      <small>KST</small>
    </div>
  )
}
function App() {
  const [screen, setScreen] = useState<'ops' | 'catalog' | 'sim'>('ops')
  const [sites, setSites] = useState<Intersection[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [district, setDistrict] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [active, setActive] = useState<string | null>('스마트_16')
  const [detail, setDetail] = useState<Intersection | null>(null)
  const [info, setInfo] = useState(false)
  useEffect(() => {
    const ctrl = new AbortController()
    setLoadState('loading')
    fetch('/api/intersections', { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw Error()
        return r.json()
      })
      .then((rows: Intersection[]) => {
        if (!ctrl.signal.aborted) {
          setSites(
            rows.sort(
              (a, b) =>
                sortKey(a) - sortKey(b) ||
                displayName(a).localeCompare(displayName(b), 'ko'),
            ),
          )
          setLoadState('ready')
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoadState('error')
      })
    return () => ctrl.abort()
  }, [attempt])
  const clean = query.trim().replaceAll(' ', '').toLowerCase()
  const filtered = useMemo(
    () =>
      sites.filter(
        (s) =>
          (!district || s.district === district) &&
          [displayName(s), s.id, 'SI-' + siteNumber(s), s.address, s.district]
            .join(' ')
            .replaceAll(' ', '')
            .toLowerCase()
            .includes(clean),
      ),
    [sites, clean, district],
  )
  function openSite(site: Intersection) {
    setActive(site.id)
    setDetail(site)
  }
  function go(next: typeof screen) {
    setScreen(next)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const isSim = screen === 'sim'
  const catalog = screen === 'catalog'
  const values = loadState === 'ready'
  const metrics = [
    {
      label: '관제 교차로',
      value: values ? sites.length : '—',
      unit: '곳',
      meta: '중부권 스마트교차로',
      icon: Waypoints,
      tone: 'mint',
    },
    {
      label: '대상 행정동',
      value: values ? new Set(sites.map((s) => s.district)).size : '—',
      unit: '개 동',
      meta: '시흥시 중부권',
      icon: MapPinned,
      tone: 'blue',
    },
    {
      label: 'CCTV 인접 교차로',
      value: 8,
      unit: '곳',
      meta: '교차로 70m 이내 카메라',
      icon: Cctv,
      tone: 'violet',
    },
    {
      label: '영상 연계',
      value: 0,
      unit: '곳',
      meta: '실시간 영상 연결 전',
      icon: RadioTower,
      tone: 'amber',
    },
  ]
  const listStatus =
    loadState === 'error' ? (
      <div className="empty">
        목록을 불러오지 못했어요.
        <button onClick={() => setAttempt((x) => x + 1)}>다시 시도</button>
      </div>
    ) : !values ? (
      <div className="empty">교차로를 불러오는 중이에요.</div>
    ) : filtered.length === 0 ? (
      <div className="empty">
        조건에 맞는 교차로가 없어요.
        <button
          onClick={() => {
            setQuery('')
            setDistrict('')
          }}
        >
          검색 조건 초기화
        </button>
      </div>
    ) : null
  const search = (
    <div className="search-tools">
      <div className="search-box">
        <Search size={16} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="교차로명 또는 주소 검색"
          aria-label="교차로 검색"
        />
      </div>
      <button
        aria-expanded={filtering}
        aria-label="행정동 필터"
        title="행정동 필터"
        className={'filter-btn' + (filtering || district ? ' on' : '')}
        onClick={() => setFiltering((v) => !v)}
      >
        <SlidersHorizontal size={17} />
      </button>
    </div>
  )
  const filter = filtering && (
    <label className="filter-row">
      행정동
      <select value={district} onChange={(e) => setDistrict(e.target.value)}>
        <option value="">전체 행정동</option>
        {districts.map((d) => (
          <option key={d}>{d}</option>
        ))}
      </select>
    </label>
  )
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <button className="brand" onClick={() => go('ops')}>
            <img src="/signal.svg" alt="" />
            <span>
              <strong>시흥 교통관제</strong>
              <small>SIHEUNG TRAFFIC CONTROL</small>
            </span>
          </button>
          <nav aria-label="주 메뉴">
            <button
              className={!catalog ? 'active' : ''}
              onClick={() => go('ops')}
            >
              <LayoutDashboard size={16} />
              관제 대시보드
            </button>
            <button
              className={catalog ? 'active' : ''}
              onClick={() => go('catalog')}
            >
              <List size={17} />
              교차로 목록
            </button>
          </nav>
          <div className="top-end">
            <Clock />
            <button
              title="자료 안내"
              aria-label="자료 안내"
              className="help"
              onClick={() => setInfo(true)}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </div>
      </header>
      <main>
        <div className="mast">
          <div>
            <h1>
              {isSim
                ? '신호 배분 시뮬레이션'
                : catalog
                  ? '교차로 목록'
                  : '교차로 관제 현황'}
            </h1>
            <p>
              {isSim
                ? '가상 교차로의 교통 수요를 바꾸고 현시별 녹색시간을 비교해 보세요.'
                : catalog
                  ? '중부권 스마트교차로를 검색하고 교차로별 상세 정보를 확인하세요.'
                  : '시흥시 중부권의 스마트교차로 위치와 CCTV 연계 현황을 확인하세요.'}
            </p>
          </div>
          <div className="mode-switch" role="group" aria-label="관제 모드">
            <button
              aria-pressed={!isSim}
              className={!isSim ? 'mode-active' : ''}
              onClick={() => go('ops')}
            >
              <Activity size={15} />
              운영 모드
            </button>
            <button
              aria-pressed={isSim}
              className={isSim ? 'sim-active' : ''}
              onClick={() => go('sim')}
            >
              <FlaskConical size={15} />
              시뮬레이션
            </button>
          </div>
        </div>
        {isSim ? (
          <Simulation />
        ) : (
          <>
            {!catalog && (
              <div className="metrics">
                {metrics.map(
                  ({ label, value, unit, meta, icon: Icon, tone }) => (
                    <article className={'card metric ' + tone} key={label}>
                      <div className="metric-top">
                        <span>{label}</span>
                        <i>
                          <Icon size={19} />
                        </i>
                      </div>
                      <div className="metric-value">
                        {value}
                        <span>{unit}</span>
                      </div>
                      <small>{meta}</small>
                    </article>
                  ),
                )}
              </div>
            )}
            {catalog ? (
              <section className="card catalog">
                <div className="panel-head">
                  <div className="panel-title">
                    <List />
                    <h2>중부권 교차로</h2>
                    <span className="count-pill">{filtered.length}</span>
                  </div>
                </div>
                <div className="catalog-search">
                  {search}
                  {filter}
                </div>
                {listStatus ?? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>현장 번호</th>
                          <th>교차로명</th>
                          <th>행정동</th>
                          <th>주소</th>
                          <th>영상 상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((s) => (
                          <tr key={s.id}>
                            <td>SI-{siteNumber(s)}</td>
                            <th>
                              <button onClick={() => openSite(s)}>
                                {displayName(s)}
                              </button>
                            </th>
                            <td>{s.district}</td>
                            <td>{s.address}</td>
                            <td>
                              <span className="status-tag">연계 전</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <>
                <div className="dashboard-grid">
                  <MapPanel
                    sites={filtered}
                    active={active}
                    onOpen={openSite}
                  />
                  <section className="card directory">
                    <div className="panel-head">
                      <div className="panel-title">
                        <List />
                        <h2>교차로 목록</h2>
                        <span className="count-pill">{filtered.length}</span>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => go('catalog')}
                      >
                        전체 보기
                        <ChevronRight size={14} />
                      </button>
                    </div>
                    {search}
                    {filter}
                    <div className="list-scroll">
                      {listStatus ??
                        filtered.map((site) => (
                          <button
                            className={
                              'site-row' +
                              (site.id === active ? ' selected' : '')
                            }
                            key={site.id}
                            onClick={() => openSite(site)}
                          >
                            <span className="row-icon">
                              <Cctv size={17} />
                            </span>
                            <span className="row-name">
                              <strong>{displayName(site)}</strong>
                              <small>
                                {site.district}
                                <i />
                                SI-{siteNumber(site)}
                              </small>
                            </span>
                            <span className="status-tag">연계 전</span>
                            <ChevronRight size={14} className="row-chevron" />
                          </button>
                        ))}
                    </div>
                    <div className="list-foot">
                      <MapPin size={13} />
                      {district || '중부권 전체'}
                      <span>{filtered.length}개 교차로</span>
                    </div>
                  </section>
                </div>
                <section className="sim-banner">
                  <span className="banner-icon">
                    <Route size={27} />
                  </span>
                  <div>
                    <h2>신호 배분 시뮬레이션</h2>
                    <p>
                      가상 교차로에서 교통량에 따른 녹색시간 변화를 살펴보세요.
                    </p>
                  </div>
                  <button onClick={() => go('sim')}>
                    <FlaskConical size={15} />
                    시뮬레이션 열기
                  </button>
                </section>
              </>
            )}
          </>
        )}
        <footer className="page-foot">
          <span>
            <Network size={14} />
            시흥 교통관제
          </span>
          <button onClick={() => setInfo(true)}>
            <BookOpen size={14} />
            자료 안내
          </button>
        </footer>
      </main>
      {detail && <SiteDialog site={detail} close={() => setDetail(null)} />}
      {info && (
        <Dialog title="자료 안내" close={() => setInfo(false)}>
          <div className="info-copy">
            <h3>스마트교차로 위치</h3>
            <p>
              시흥시 스마트교차로 현황(2025. 11. 05.)에서 중부권 6개 행정동의
              18곳을 표시했어요. SI 번호는 원자료의 현장번호와 대응해요.
            </p>
            <a
              href="https://www.data.go.kr/data/15090289/fileData.do"
              target="_blank"
              rel="noreferrer"
            >
              시흥시 스마트교차로 현황
            </a>
            <h3>CCTV 인접 기준</h3>
            <p>
              팀이 2026년 11월 18일 경기도교통정보센터 지도에서 확인한 결과예요.
              교차로 70m 안에 카메라가 있는 8곳을 집계했어요. 현재 연결한 실시간
              영상은 0곳이에요.
            </p>
            <h3>시뮬레이션</h3>
            <p>
              기술설계서 6.6절의 가상 수요와 기존 녹색시간 배분 엔진을 사용해요.
              주기는 120초, 녹색시간 합은 100초예요.
            </p>
          </div>
        </Dialog>
      )}
    </>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
