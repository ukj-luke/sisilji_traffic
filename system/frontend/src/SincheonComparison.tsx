import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { CirclePause, Download, ExternalLink, Film, ListVideo, Play } from 'lucide-react'
import './sincheon-comparison.css'

const base = '/cases/sincheon/'
const clock = (kst: string) => kst.slice(11, 19)
const seconds = (value: number) => Number(value.toFixed(3)).toString()
const kinds = { queue: '정차', passage: '통과', signal: '신호', other: '기타 관측' }
type Kind = keyof typeof kinds
type Link = { label: string; path: string }
type Group = { id: string; label: string; report: string; downloads: Link[] }
type Mark = {
  t: number; representativePts?: number; kind: Kind; label: string; direction: string; note: string
  actual: string | null; still: string | null
}
type QueueReading = {
  t0: number
  q0: number | null; q1: number | null
  range0: number[] | null; range1: number[] | null; error: number | null
}
type Clip = {
  id: string; group: string; label: string; received: string; file: string
  frames: number; kind: 'original' | 'frames'; firstPts: number; frameTable: string
  overlapWith: string | null; summary: string; marks: Mark[]; queue: QueueReading | null
}
type Archive = {
  date: string; groups: Group[]; clips: Clip[]; downloads: Link[]
  pair: {clip: string; t: number}[]
}
type Selection = {clip: Clip; mark: Mark | null}
type Side = '왼쪽' | '오른쪽'

function firstScene(clip: Clip, archive: Archive): Selection {
  const start = clip.queue?.t0 ?? archive.pair.find(item => item.clip === clip.id)?.t
  const queueStart = clip.marks.find(m => m.kind === 'queue' && start === m.t)
  const mark = queueStart ?? clip.marks.find(m => m.kind === 'queue') ?? clip.marks[0] ?? null
  return { clip, mark }
}

// Morning videos start at the first recovered frame, not at source timestamp zero.
function playbackTime(clip: Clip, mark: Mark | null) {
  if (!mark) return 0
  const pts = mark.representativePts ?? mark.t
  return Math.max(0, pts - (clip.kind === 'frames' ? clip.firstPts : 0))
}

function timestampLabel(clip: Clip, mark: Mark) {
  const played = seconds(playbackTime(clip, mark)) + '초'
  return mark.representativePts == null
    ? '영상 ' + played
    : '대표 재생 ' + played + ' · 원본 종료 ' + seconds(mark.t) + '초'
}

function count(value: number | null, range: number[] | null) {
  if (value != null) return value + '대'
  return range?.length === 2 ? range.join('~') + '대' : '미측정'
}

function Player({ side, archive, selection, onSelect, videoRef, onPlaybackChange }: {
  side: Side; archive: Archive; selection: Selection; onSelect: (next: Selection) => void
  videoRef: RefObject<HTMLVideoElement | null>; onPlaybackChange: () => void
}) {
  const { clip, mark } = selection
  const pending = useRef<number | null>(null)
  const [failed, setFailed] = useState(false)
  const seek = useCallback(() => {
    const video = videoRef.current
    if (pending.current === null || !video || video.readyState < 1) return
    video.pause()
    const end = Number.isFinite(video.duration) ? video.duration : Infinity
    video.currentTime = Math.min(pending.current, end)
    pending.current = null
  }, [videoRef])
  useEffect(() => {
    pending.current = playbackTime(clip, mark)
    seek()
    onPlaybackChange()
  }, [selection, clip, mark, seek, onPlaybackChange])
  useEffect(() => setFailed(false), [clip.file])
  return <article className="sc-player" id={side === '왼쪽' ? 'sc-left-player' : 'sc-right-player'} tabIndex={-1} aria-label={side + ' 영상'}>
    <div className="sc-player-head">
      <label><span>{side} 영상</span>
        <select aria-label={side + ' 영상 선택'} value={clip.id} onChange={e => {
          const next = archive.clips.find(c => c.id === e.target.value)
          if (next) onSelect(firstScene(next, archive))
        }}>
          {archive.groups.map(g => <optgroup key={g.id} label={g.label}>
            {archive.clips.filter(c => c.group === g.id).map(c =>
              <option value={c.id} key={c.id}>{c.label}</option>)}
          </optgroup>)}
        </select>
      </label>
      <p><time dateTime={clip.received}>{clock(clip.received)}</time> 수신 · {clip.kind === 'frames' ? '저장 프레임 재구성' : '수신 원본'}</p>
      {mark && <p className="sc-count-title">{mark.direction}{mark.actual && <> · <strong>{mark.actual}</strong></>}</p>}
    </div>
    <video key={clip.file} ref={videoRef} controls playsInline muted preload="auto"
      aria-label={side + ' 신천사거리 ' + clock(clip.received) + ' 수신 영상'}
      src={base + clip.file} onLoadedMetadata={() => {seek(); onPlaybackChange()}} onLoadedData={seek}
      onPlay={onPlaybackChange} onPause={onPlaybackChange} onEnded={onPlaybackChange} onEmptied={onPlaybackChange}
      onError={() => {setFailed(true); onPlaybackChange()}} />
    {failed && <p role="alert">영상을 재생할 수 없습니다. 아래 MP4 링크에서 파일을 확인하세요.</p>}
    <div className="sc-reading" aria-live="polite">
      <p className="sc-reading-kicker">{mark ? kinds[mark.kind] + ' 판독 · ' + timestampLabel(clip, mark) : '관측 기록'}</p>
      <p>{mark?.note || clip.summary}</p>
      {mark?.still && <a href={base + mark.still} target="_blank" rel="noreferrer">근거 이미지 <ExternalLink size={13}/></a>}
    </div>
    {clip.queue && <div className="sc-queue-note">
      <b>구간 정차 대수</b>
      <span>시작 {count(clip.queue.q0, clip.queue.range0)} → 종료 {count(clip.queue.q1, clip.queue.range1)}</span>
      <span>시작 대수 유지 예측−실측 {clip.queue.error == null ? '미산출' : (clip.queue.error > 0 ? '+' : '') + clip.queue.error + '대'}</span>
    </div>}
    <div className="sc-player-files">
      <a href={base + clip.file} download><Download size={14} aria-hidden="true"/>{clip.kind === 'frames' ? '재구성 MP4' : '원본 MP4'}</a>
      <a href={base + clip.frameTable} download>프레임 CSV</a>
    </div>
  </article>
}

function Reader({ archive }: { archive: Archive }) {
  const [left, setLeft] = useState(() => firstScene(archive.clips.find(c => c.id === '07-E') ?? archive.clips[0], archive))
  const [right, setRight] = useState(() => firstScene(archive.clips.find(c => c.id === '1052') ?? archive.clips[archive.clips.length - 1], archive))
  const [group, setGroup] = useState('selected')
  const [kind, setKind] = useState('all')
  const leftVideo = useRef<HTMLVideoElement>(null)
  const rightVideo = useRef<HTMLVideoElement>(null)
  const [bothPlaying, setBothPlaying] = useState(false)
  const [bothReady, setBothReady] = useState(false)
  const [playError, setPlayError] = useState('')
  const refreshPlayback = useCallback(() => {
    const videos = [leftVideo.current, rightVideo.current]
    setBothPlaying(videos.every(v => v && !v.paused && !v.ended))
    setBothReady(videos.every(v => v && v.readyState >= 1 && !v.error))
  }, [])
  useEffect(() => setPlayError(''), [left, right])
  async function toggleBoth() {
    const a = leftVideo.current
    const b = rightVideo.current
    if (!a || !b) return
    setPlayError('')
    if (!a.paused && !a.ended && !b.paused && !b.ended) {
      a.pause()
      b.pause()
      return
    }
    if (a.ended) a.currentTime = playbackTime(left.clip, left.mark)
    if (b.ended) b.currentTime = playbackTime(right.clip, right.mark)
    const results = await Promise.allSettled([a.play(), b.play()])
    if (a !== leftVideo.current || b !== rightVideo.current) return
    const blocked = results.some(r => r.status === 'rejected' && r.reason?.name !== 'AbortError')
    if (blocked) setPlayError('두 영상 중 재생이 시작되지 않은 영상은 해당 재생 버튼으로 열어 주세요.')
    refreshPlayback()
  }
  function jump(side: Side, selection: Selection) {
    if (side === '왼쪽') setLeft(selection)
    else setRight(selection)
    requestAnimationFrame(() => {
      const player = document.getElementById(side === '왼쪽' ? 'sc-left-player' : 'sc-right-player')
      player?.focus({preventScroll: true})
      player?.scrollIntoView({block: 'start'})
    })
  }
  const clips = archive.clips.filter(c => group === 'selected' ? c.id === left.clip.id || c.id === right.clip.id : c.group === group)
  const rows = clips.flatMap(clip => clip.marks.filter(mark => kind === 'all' || mark.kind === kind).map(mark => ({clip, mark})))
  return <>
    <div className="sc-transport">
      <button type="button" disabled={!bothReady} onClick={() => void toggleBoth()}>
        {bothPlaying ? <CirclePause size={16} aria-hidden="true"/> : <Play size={16} aria-hidden="true"/>}
        {bothPlaying ? '두 영상 일시정지' : '두 영상 재생'}
      </button>
      <span>각 영상의 현재 재생 위치에서 시작합니다.</span>
      {playError && <span role="alert">{playError}</span>}
    </div>
    <div className="sc-players">
      <Player side="왼쪽" archive={archive} selection={left} onSelect={setLeft} videoRef={leftVideo} onPlaybackChange={refreshPlayback}/>
      <Player side="오른쪽" archive={archive} selection={right} onSelect={setRight} videoRef={rightVideo} onPlaybackChange={refreshPlayback}/>
    </div>
    <section className="card sc-observations">
      <header className="sc-table-head">
        <div><h3><ListVideo size={19} aria-hidden="true"/> 장면 판독표</h3>
          <p>판독 시점을 열 영상을 고르세요. 영상 시각은 해당 MP4의 시작부터 지난 시간입니다.</p></div>
        <div className="sc-filters">
          <label>시간대<select value={group} onChange={e => setGroup(e.target.value)}>
            <option value="selected">선택한 두 영상</option>
            {archive.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select></label>
          <label>판독 항목<select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="all">전체 항목</option>
            {Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </div>
      </header>
      <table className="sc-table">
        <caption>선택한 범위의 정차·통과·신호 판독 시점</caption>
        <thead><tr><th scope="col">수신 / 영상 시각</th><th scope="col">항목</th><th scope="col">방향과 판독 결과</th><th scope="col">장면 열기</th></tr></thead>
        <tbody>{rows.map(({ clip, mark }, i) => <tr key={clip.id + '-' + i}>
          <th scope="row"><time dateTime={clip.received}>{clock(clip.received)}</time>
            <small className={mark.representativePts == null ? undefined : 'sc-representative-time'}>{timestampLabel(clip, mark)}</small></th>
          <td><span className={'sc-kind sc-' + mark.kind}>{kinds[mark.kind]}</span></td>
          <td><strong>{mark.direction}</strong><small>{mark.label}{mark.actual ? ' · ' + mark.actual : ''}</small></td>
          <td><div className="sc-targets">{(['왼쪽', '오른쪽'] as const).map(side => {
            const selected = side === '왼쪽' ? left : right
            return <button key={side} type="button" aria-pressed={selected.clip.id === clip.id && selected.mark === mark}
              aria-label={side + ' 영상에서 ' + clock(clip.received) + ' 수신 ' + seconds(playbackTime(clip, mark)) + '초 ' + mark.label + ' 열기'}
              onClick={() => jump(side, {clip, mark})}>{side}</button>
          })}</div></td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <p className="sc-empty">이 범위에 해당하는 판독 기록이 없습니다.</p>}
    </section>
    <details className="card sc-sources">
      <summary>관측 보고서와 자료 내려받기</summary>
      <div className="sc-source-grid">
        {archive.groups.map(g => <section key={g.id}><h4>{g.label}</h4>
          <a href={base + g.report} target="_blank" rel="noreferrer">상세 관측 보고서 <ExternalLink size={13}/></a>
          {g.downloads.map(link => <a key={link.path} href={base + link.path} download>{link.label}</a>)}
        </section>)}
      </div>
      {!!archive.downloads.length && <div className="sc-archive-files">{archive.downloads.map(link =>
        <a key={link.path} href={base + link.path} download><Download size={14}/>{link.label}</a>)}</div>}
    </details>
  </>
}

export default function SincheonComparison() {
  const [archive, setArchive] = useState<Archive | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState(false)
  useEffect(() => {
    const previousTitle = document.title
    document.title = '신천사거리 CCTV 비교 · 시흥 ITS'
    return () => { document.title = previousTitle }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    fetch(base + 'manifest.json', {signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw Error('관측 자료')
        const data: Archive = await response.json()
        if (!data.clips?.length) throw Error('영상 목록')
        if (!controller.signal.aborted) setArchive(data)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [attempt])
  return <section className="sc-comparison" aria-labelledby="sc-title">
    <header className="sc-heading">
      <div className="sc-site"><Film size={16} aria-hidden="true"/>시흥 신천사거리 · CCTV 6575</div>
      <h2 id="sc-title">시간대별 현장 영상 대조</h2>
      <p>{archive?.date ?? '2026-11-23'}에 실제 신호로 운영된 신천사거리 영상입니다. 두 장면을 골라 비교하세요. 목록의 시각은 한국시간 수신 시각입니다.</p>
    </header>
    {archive ? <Reader archive={archive}/> : error
      ? <p role="alert">관측 자료를 열 수 없습니다. <button className="subtle-button" onClick={() => setAttempt(n => n + 1)}>다시 불러오기</button></p>
      : <p role="status">관측 자료를 불러오는 중입니다.</p>}
  </section>
}
