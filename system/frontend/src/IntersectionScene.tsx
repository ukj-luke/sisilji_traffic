import { memo, useId } from 'react'
import type { TrafficFrame } from './trafficMotion'
import './intersection-scene.css'

type Props = {
  method: 'fixed' | 'auto'
  frame: TrafficFrame
  direction: number
  phases: string[]
  idle: boolean
}

const spacing = 13
const stopX = -52
const roadRotations = [0, 90, 180, 270]
const turnRadius = 40
const curveStartX = 8 - turnRadius
const arcLength = Math.PI * turnRadius / 2

// Canonical approach is west to east on the right-hand side. Rotating the
// whole path produces the opposing approach and both north/south approaches.
function approachRotation(phase: number, arm: number) {
  return (phase < 2 ? 0 : -90) + 180 * arm
}

function positionOnRoad(distance: number, leftTurn: boolean) {
  const x = stopX + distance * spacing
  if (!leftTurn || x <= curveStartX)
    return { x, y: leftTurn ? 8 : 24, heading: 0 }

  const alongCurve = x - curveStartX
  if (alongCurve >= arcLength)
    return { x: 8, y: curveStartX - (alongCurve - arcLength), heading: -90 }

  const angle = alongCurve / turnRadius
  return {
    x: curveStartX + turnRadius * Math.sin(angle),
    y: curveStartX + turnRadius * Math.cos(angle),
    heading: -angle * 180 / Math.PI,
  }
}

const StreetMap = memo(function StreetMap() {
  return (
    <g aria-hidden="true">
      <rect x="-150" y="-110" width="300" height="220" fill="#233f42" />
      {/* Pavements and city blocks frame the four approaches. */}
      {roadRotations.map((angle) => (
        <g key={angle} transform={`rotate(${angle})`}>
          <path d="M36 154V50Q36 36 51 36H154" stroke="#697e78" strokeWidth="6" fill="none" />
          <path d="M42 154V52Q42 42 53 42H154" stroke="#395551" strokeWidth="3" fill="none" />
        </g>
      ))}
      <g fill="#3a5556" stroke="#4e6968" strokeWidth="1">
        <rect x="-139" y="-98" width="45" height="39" rx="3" />
        <rect x="-89" y="-106" width="22" height="31" rx="2" />
        <rect x="77" y="-98" width="52" height="25" rx="2" />
        <rect x="107" y="-68" width="31" height="14" rx="2" />
        <rect x="63" y="58" width="27" height="38" rx="2" />
        <rect x="95" y="70" width="43" height="26" rx="2" />
      </g>
      <g fill="#486969" opacity=".8">
        <rect x="-134" y="-93" width="34" height="4" rx="1" />
        <rect x="81" y="-94" width="42" height="4" rx="1" />
        <rect x="67" y="63" width="4" height="25" rx="1" />
      </g>
      <g fill="#365c52">
        <circle cx="-115" cy="78" r="12" />
        <circle cx="-92" cy="83" r="9" />
        <circle cx="-78" cy="66" r="11" />
        <circle cx="60" cy="-58" r="7" />
      </g>
      <path d="M-150 -33H-45Q-33 -33 -33 -45V-110H33V-45Q33 -33 45 -33H150V33H45Q33 33 33 45V110H-33V45Q-33 33 -45 33H-150Z"
        fill="#293641" stroke="#9aa8a6" strokeWidth="1.2" />
      {roadRotations.map((angle) => (
        <g key={angle} transform={`rotate(${angle})`}>
          <path d="M-154 -.9H-47 M-154 .9H-47" stroke="#c7a566" strokeWidth=".8" />
          <path d="M-154 16H-52 M-154 -16H-52" stroke="#94a2a7" strokeWidth=".8" strokeDasharray="5 5" />
          <path d="M-45 2V31" stroke="#e9eee9" strokeWidth="1.8" />
          {[-27,-20,-13,-6,6,13,20,27].map(y => (
            <path key={y} d={`M-41 ${y}h5`} stroke="#ced7d4" strokeWidth="2.7" />
          ))}
          <g stroke="#c9d3d4" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M-91 24h9m-3 -2.4 3 2.4 -3 2.4" />
            <path d="M-91 8h5q3 0 3 -3v-1.5m-2 2 2 -2 2 2" />
          </g>
        </g>
      ))}
      <g fill="#e1ebe5" aria-hidden="true" transform="translate(139 -92)">
        <path d="M0 -10 -3 0 0 -2 3 0Z" />
        <text y="10" fontSize="8" textAnchor="middle">북</text>
      </g>
    </g>
  )
})

export default function IntersectionScene({ method, frame, direction, phases, idle }: Props) {
  const carId = useId().replace(/:/g, '') + '-vehicle'
  const name = method === 'fixed' ? '고정 신호' : '자동 배분'
  const green = frame.greenPhase
  const status = idle ? '출발 전' : green === null ? '전체 정지' : phases[green] + ' 녹색'
  return (
    <figure className={'junction-scene scene-' + method}>
      <figcaption className="scene-heading">
        <strong>{name}</strong>
        <span className={'scene-signal-state ' + (idle ? 'waiting' : green === null ? 'red' : 'green')}>
          <i aria-hidden="true" />{status}
        </span>
      </figcaption>
      <svg className="scene-viewport" viewBox="-150 -110 300 220" role="img"
        aria-label={`${name} 교차로, ${status}. ${phases[direction]} 대기 ${frame.queues[direction]}대`}>
        <defs>
          <g id={carId}>
            <rect x="-5.7" y="-3" width="11.4" height="6" rx="1.8"
              fill="currentColor" stroke="#162830" strokeWidth=".65" />
            <path d="M-.7 -2.1h2.9l.9 4.2H-.6Z" fill="#46606b" />
            <path d="M-3.5 -1.9h1.1v3.8h-1.1Z" fill="#5c7480" />
            <path d="M4.8 -1.9v.8m0 2v.8" stroke="#fff6cc" strokeWidth="1" />
          </g>
        </defs>
        <StreetMap />
        {([0, 1, 2, 3] as const).map(phase =>
          ([0, 1] as const).map(arm => {
            const rotation = approachRotation(phase, arm)
            const y = phase % 2 ? 8 : 24
            const signalColor = idle ? '#aab9ba' : green === phase ? '#5ee8a9' : '#ff8a77'
            return (
              <g key={phase + '-' + arm} transform={`rotate(${rotation})`}>
                {phase === direction && (
                  <path d={`M-151 ${y}H-47`} stroke="#f0cc75" strokeWidth="13" opacity=".10" />
                )}
                {/* Individual movement signals at each stop line. */}
                <path d={`M-45 ${y - 4.2}v8.4`} stroke="#12252d" strokeWidth="4.5" strokeLinecap="round" />
                <path d={`M-45 ${y - 3.3}v6.6`} stroke={signalColor} strokeWidth="2.4" strokeLinecap="round" />
              </g>
            )
          }),
        )}
        {frame.cars.map(car => {
          const point = positionOnRoad(car.distance, car.phase % 2 === 1)
          return (
            <use key={car.id} href={'#' + carId}
              color={car.phase === direction ? '#ffd073' : '#d0dde5'}
              transform={`rotate(${approachRotation(car.phase, car.arm)}) translate(${point.x} ${point.y}) rotate(${point.heading})`} />
          )
        })}
      </svg>
      <div className="scene-footer">
        <span><i aria-hidden="true" />{phases[direction]}</span>
        <dl className="scene-counts">
          <div><dt>현재 대기</dt><dd><strong>{frame.queues[direction].toLocaleString('ko-KR')}대</strong></dd></div>
          <div><dt>누적 통과</dt><dd>{frame.passed[direction].toLocaleString('ko-KR')}대</dd></div>
        </dl>
      </div>
    </figure>
  )
}
