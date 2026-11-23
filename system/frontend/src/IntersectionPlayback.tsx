import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import IntersectionScene from './IntersectionScene'
import { buildMotionPair, frameAt } from './trafficMotion'
import './intersection-playback.css'

export type PlaybackActions = {
  busy: boolean
  error: string
  continuous: boolean
  setContinuous: (value: boolean) => void
  onNext: () => void
  onReset: () => void
}

type Props = PlaybackActions & {
  motion: Parameters<typeof buildMotionPair>[0]
  phases: string[]
  direction: number
  cycle: number
  speed: number
  setSpeed: (speed: number) => void
}

const cycleSeconds = 120
function clock(seconds: number) {
  const whole = Math.floor(seconds)
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0')
}

export default function IntersectionPlayback({
  motion, phases, direction, cycle, speed, setSpeed, busy, error,
  continuous, setContinuous, onNext, onReset,
}: Props) {
  // The parent mounts a fresh player only after both calculations succeed.
  const [time, setTime] = useState(0)
  const [running, setRunning] = useState(cycle > 0 && Boolean(motion.traces))
  const position = useRef(0)
  const finished = useRef(false)
  const plans = useMemo(() => buildMotionPair(motion), [motion])
  const started = cycle > 0
  const hasEvents = motion.traces !== undefined
  const ended = time >= cycleSeconds

  useEffect(() => {
    if (!running) return
    let request: number
    let last: number | undefined
    function tick(now: number) {
      if (last === undefined) last = now
      if (now - last >= 1000 / 30) {
        // Keep the two drawings on one clock, including after Safari suspends a tab.
        position.current = Math.min(cycleSeconds, position.current + Math.min(now - last, 100) * speed / 1000)
        last = now
        setTime(position.current)
        if (position.current >= cycleSeconds) {
          finished.current = true
          setRunning(false)
          return
        }
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [running, speed])

  useEffect(() => {
    if (ended && finished.current && continuous && !busy) {
      finished.current = false
      onNext()
    }
  }, [ended, continuous, busy, onNext])

  function seek(seconds: number) {
    finished.current = false
    position.current = seconds
    setTime(seconds)
    setRunning(false)
  }
  function togglePlayback() {
    if (!started) {
      onNext()
    } else if (ended) {
      seek(0)
      setRunning(true)
    } else {
      setRunning(!running)
    }
  }
  const action = !started ? '한 주기 재생' : ended ? '다시 보기' : running ? '일시정지' : '이어서 재생'

  return (
    <div className="intersection-playback">
      <div className="movie-controls">
        <div className="sim-buttons">
          <button className="primary" onClick={togglePlayback} disabled={busy || (started && !hasEvents)}>
            {running ? <Pause size={15} /> : <Play size={15} />} {action}
          </button>
          {started && <button onClick={onNext} disabled={busy}>
            <SkipForward size={15} /> 다음 주기
          </button>}
          <button className="icon-button" aria-label="시뮬레이션 초기화" onClick={onReset}>
            <RotateCcw size={15} />
          </button>
        </div>
        <div className="movie-options">
          <label>재생 속도 <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
            {[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}배</option>)}
          </select></label>
          <label><input type="checkbox" checked={continuous}
            onChange={e => setContinuous(e.target.checked)} /> 연속 재생</label>
        </div>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="intersection-pair">
        {(['fixed', 'auto'] as const).map(method => (
          <IntersectionScene key={method} method={method} frame={frameAt(plans[method], time)}
            direction={direction} phases={phases} idle={!started || !hasEvents} />
        ))}
      </div>
      <label className="cycle-scrub">
        <span>{started ? cycle + '번째 주기' : '첫 주기'} <b>{clock(time)}</b> / 2:00</span>
        <input aria-label="주기 재생 위치" type="range" min="0" max={cycleSeconds}
          step="0.1" value={time} disabled={!started || !hasEvents || busy}
          aria-valuetext={Math.floor(time) + '초'} onChange={e => seek(Number(e.target.value))} />
      </label>
      {started && hasEvents && (
        <section className="phase-windows" aria-label={phases[direction] + ' 녹색 신호 시간 비교'}>
          <h4>{phases[direction]} 녹색 구간</h4>
          {(['fixed', 'auto'] as const).map(method => {
            const { start, end } = plans[method][direction]
            const name = method === 'fixed' ? '고정 신호' : '자동 배분'
            return (
              <div className="phase-window" key={method}>
                <span>{name}</span>
                <button type="button" className="phase-track"
                  aria-label={name + ' ' + phases[direction] + ' 녹색 시작 ' + start + '초로 이동'}
                  title={clock(start) + '에 녹색 시작'} onClick={() => seek(start)}>
                  <i style={{left: (start / cycleSeconds * 100) + '%', width: ((end - start) / cycleSeconds * 100) + '%'}} />
                  <b style={{left: (time / cycleSeconds * 100) + '%'}} />
                </button>
                <small>{clock(start)}–{clock(end)} <strong>{end - start}초</strong></small>
              </div>
            )
          })}
        </section>
      )}
      <p className="movie-caption">{!started
        ? '두 교차로에 같은 시각에 차량이 도착합니다. 노란 차량은 선택한 방향입니다.'
        : hasEvents
          ? '대기·통과 대수와 신호 전환은 모형의 사건 시각에 맞췄습니다. 차량 위치와 양방향 분할은 도식이며 화면 밖의 대기도 집계합니다.'
          : '이 주기의 차량별 시각 기록을 확인할 수 없습니다.'}</p>
    </div>
  )
}
