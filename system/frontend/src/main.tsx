import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
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
import { followDesktopViewport } from './desktop-viewport'
import { Dialog, SiteDialog } from './Dialogs'
import {
  LiveCctvDialog,
  adjacentCamera,
  siteVideoLabel,
  useCameraCatalog,
} from './LiveCctv'
import { MapPanel } from './MapPanel'
import { isSimulationHash, Simulation } from './Simulation'
import { districts, displayName, siteNumber, type Intersection } from './types'
import brand from '../public/signal.svg'
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
function screenFromHash(): 'ops' | 'catalog' | 'sim' {
  if (isSimulationHash(window.location.hash)) return 'sim'
  if (window.location.hash === '#catalog') return 'catalog'
  return 'ops'
}
function liveFromHash() {
  const match = /^#cctv(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(window.location.hash)
  return match ? (match[1] ?? '') : null
}
function App() {
  useLayoutEffect(followDesktopViewport, [])
  const [screen, setScreen] = useState(screenFromHash)
  const [sites, setSites] = useState<Intersection[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [district, setDistrict] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [dashboardView, setDashboardView] = useState<'map' | 'list'>('map')
  const [active, setActive] = useState<string | null>('스마트_16')
  const [detail, setDetail] = useState<Intersection | null>(null)
  const [info, setInfo] = useState(false)
  const [liveId, setLiveId] = useState(liveFromHash)
  const liveCatalog = useCameraCatalog(screen !== 'sim' || liveId !== null)
  function openLive(id = '') {
    setDetail(null)
    window.history.pushState(
      { openedCamera: true },
      '',
      id ? '#cctv/' + id : '#cctv',
    )
    setLiveId(id)
  }
  function closeLive() {
    if (window.history.state?.openedCamera) {
      window.history.back()
      return
    }
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    )
    setLiveId(null)
  }
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
  const visibleCameras = useMemo(
    () =>
      liveCatalog.cameras.filter(
        (c) =>
          (!district || c.district === district) &&
          (c.name + c.district).replaceAll(' ', '').includes(clean),
      ),
    [liveCatalog.cameras, district, clean],
  )
  function openSite(site: Intersection) {
    setActive(site.id)
    setDetail(site)
  }
  useEffect(() => {
    function handleNavigation(event: HashChangeEvent) {
      setScreen(screenFromHash())
      setLiveId(liveFromHash())
      const previous = new URL(event.oldURL).hash
      const current = window.location.hash
      if (!previous.startsWith('#cctv') && !current.startsWith('#cctv'))
        window.scrollTo({ top: 0, behavior: 'instant' })
    }
    window.addEventListener('hashchange', handleNavigation)
    return () => window.removeEventListener('hashchange', handleNavigation)
  }, [])
  function go(next: typeof screen) {
    const hashes = { ops: '', catalog: '#catalog', sim: '#simulation/dundae' }
    window.location.hash = hashes[next]
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
      tone: 'brand-metric',
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
      label: '시내 교차로 CCTV',
      value: liveCatalog.state === 'ready' ? liveCatalog.cameras.length : '—',
      unit: '대',
      meta: '중부권 현장 확인 카메라',
      icon: Cctv,
      tone: 'violet',
    },
    {
      label: '현장 CCTV 확인 지점',
      value:
        values && liveCatalog.state === 'ready'
          ? sites.filter((s) => adjacentCamera(s, liveCatalog.cameras)).length
          : '—',
      unit: '곳',
      meta: '스마트교차로 18곳 중',
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
          placeholder={
            screen === 'catalog'
              ? '교차로명 또는 주소 검색'
              : '교차로명 또는 행정동 검색'
          }
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
            <img src={brand} alt="" />
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
                ? '실제 조사표와 모형 계산을 대조하고, 같은 교통 수요에서 고정 신호와 자동 배분을 비교합니다.'
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
                            <th scope="row">
                              <button onClick={() => openSite(s)}>
                                {displayName(s)}
                              </button>
                            </th>
                            <td>{s.district}</td>
                            <td>{s.address}</td>
                            <td>
                              <span className="status-tag">
                                {siteVideoLabel(
                                  s,
                                  liveCatalog.cameras,
                                  liveCatalog.state,
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <div className="operations">
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
                <div className="dashboard-grid" data-view={dashboardView}>
                  <div
                    className="dashboard-views"
                    role="group"
                    aria-label="관제 화면"
                  >
                    <button
                      aria-pressed={dashboardView === 'map'}
                      aria-controls="camera-map"
                      onClick={() => setDashboardView('map')}
                    >
                      <MapPin size={16} /> 지도
                    </button>
                    <button
                      aria-pressed={dashboardView === 'list'}
                      aria-controls="camera-directory"
                      onClick={() => setDashboardView('list')}
                    >
                      <List size={16} /> CCTV 목록
                    </button>
                  </div>
                  <MapPanel
                    sites={filtered}
                    active={active}
                    onOpen={openSite}
                    cameras={visibleCameras}
                    onLive={openLive}
                  />
                  <section className="card directory" id="camera-directory">
                    <div className="panel-head">
                      <div className="panel-title">
                        <List />
                        <h2>시내 교차로 CCTV</h2>
                        <span className="count-pill">
                          {visibleCameras.length}
                        </span>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => openLive()}
                      >
                        영상 선택
                        <ChevronRight size={14} />
                      </button>
                    </div>
                    {search}
                    {filter}
                    <div className="list-scroll">
                      {visibleCameras.map((c) => (
                        <button
                          className="site-row"
                          key={c.id}
                          onClick={() => openLive(c.id)}
                        >
                          <span className="row-icon">
                            <Cctv size={17} />
                          </span>
                          <span className="row-name">
                            <strong>{c.name}</strong>
                            <small>{c.district}</small>
                          </span>
                          <span className="status-tag">영상 보기</span>
                          <ChevronRight size={14} className="row-chevron" />
                        </button>
                      ))}
                      {!visibleCameras.length && (
                        <div className="empty">
                          {liveCatalog.state === 'error' ? (
                            <button onClick={liveCatalog.retry}>
                              CCTV 목록 다시 받기
                            </button>
                          ) : liveCatalog.state === 'loading' ? (
                            'CCTV 목록을 불러오는 중이에요.'
                          ) : (
                            '이 조건에 맞는 시내 교차로 CCTV가 없어요.'
                          )}
                        </div>
                      )}
                    </div>
                    <div className="list-foot">
                      <MapPin size={13} />
                      {district || '중부권 전체'}
                      <span>CCTV {visibleCameras.length}대</span>
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
              </div>
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
      {detail && (
        <SiteDialog
          site={detail}
          close={() => setDetail(null)}
          cameras={liveCatalog.cameras}
          openNearby={() => openLive()}
        />
      )}
      {liveId !== null && (
        <LiveCctvDialog
          {...liveCatalog}
          id={liveId}
          close={closeLive}
          select={(id) => {
            window.history.replaceState(window.history.state, '', '#cctv/' + id)
            setLiveId(id)
          }}
        />
      )}
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
            <h3>시내 교차로 CCTV 기준</h3>
            <p>
              월곶동, 군자동, 장곡동, 능곡동, 연성동, 목감동의 행정동 경계
              안에서 시흥시와 경기도가 공개한 교차로 영상을 표시해요. IC나
              지하차도 인근에서는 지상 교차로를 확인한 영상만 포함해요.
              스마트교차로 목록에서 현장 영상이 연결된 지점도 확인할 수 있어요.
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
