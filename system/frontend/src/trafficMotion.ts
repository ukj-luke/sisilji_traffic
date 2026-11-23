export type CarPose = {
  id: string
  phase: number
  arm: 0 | 1
  /** Car spacings along the movement path. The first waiting car stops at 0. */
  distance: number
}

export type TrafficFrame = {
  cars: CarPose[]
  greenPhase: number | null
  queues: number[]
  passed: number[]
}

export type MovementTraces = {
  arrivals: number[][]
  fixedDepartures: number[][]
  autoDepartures: number[][]
}

type Inputs = {
  traces?: MovementTraces
  fixedStart: number[]
  autoStart: number[]
  fixedGreen: number[]
  autoGreen: number[]
}

type Lane = {
  initial: number
  joins: number[]
  departures: number[]
}

type Phase = {
  start: number
  end: number
  lanes: [Lane, Lane]
}

const clearance = 5
const approachTime = 2
const followTime = 0.55
const exitSpeed = 3
const visibleQueue = 15
const arms = [0, 1] as const

export function greenWindows(greens: number[]) {
  let start = 0
  return greens.map(green => {
    const window = { start, end: start + green }
    start = window.end + clearance
    return window
  })
}

// The point-queue model logs FIFO events for each movement. Its two opposing
// approaches are drawn schematically. Alternating incoming cars by arrival
// index keeps each new car on the same approach in both comparisons. Start the
// initial FIFO sequence on the opposite parity when needed so the last
// pre-existing car and the first arriving car use different approaches.
export function buildMotionPair(inputs: Inputs) {
  function build(greens: number[], initial: number[], departures?: number[][]): Phase[] {
    return greenWindows(greens).map((window, phase) => {
      const initialCount = initial[phase]
      const lanes: [Lane, Lane] = [
        { initial: Math.floor(initialCount / 2), joins: [], departures: [] },
        { initial: Math.ceil(initialCount / 2), joins: [], departures: [] },
      ]
      const arrivals = inputs.traces?.arrivals[phase] ?? []
      arrivals.forEach((time, index) => lanes[index % 2].joins.push(time))
      departures?.[phase].forEach((time, index) => {
        lanes[(index + initialCount) % 2].departures.push(time)
      })
      return { ...window, lanes }
    })
  }
  return {
    fixed: build(inputs.fixedGreen, inputs.fixedStart, inputs.traces?.fixedDepartures),
    auto: build(inputs.autoGreen, inputs.autoStart, inputs.traces?.autoDepartures),
  }
}

function countThrough(times: number[], time: number) {
  let low = 0
  let high = times.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (times[mid] <= time) low = mid + 1
    else high = mid
  }
  return low
}

export function frameAt(plan: Phase[], seconds: number): TrafficFrame {
  const time = Math.max(0, Math.min(120, seconds))
  const frame: TrafficFrame = { cars: [], greenPhase: null, queues: [], passed: [] }
  plan.forEach(({ start, end, lanes }, phase) => {
    if (start <= time && time < end) frame.greenPhase = phase
    frame.queues[phase] = 0
    frame.passed[phase] = 0
    for (const arm of arms) {
      const { initial, joins, departures } = lanes[arm]
      const released = countThrough(departures, time)
      frame.passed[phase] += released
      frame.queues[phase] += initial + countThrough(joins, time) - released
      // The next car takes a short time to pull up after the lead car leaves.
      const pullUp = released ? Math.min(1, (time - departures[released - 1]) / followTime) : 1
      const front = released - (1 - pullUp)
      // Only instantiate vehicles currently on the diagram. A queue thousands
      // of cars deep still costs the same to draw, and its numeric total stays exact.
      const first = time === 120 ? released : countThrough(departures, time - 19 / exitSpeed)
      const last = Math.min(released + visibleQueue, initial + countThrough(joins, time + approachTime))
      for (let car = first; car < last; car++) {
        const newcomer = car - initial
        let distance: number
        if (car < released) {
          distance = (time - departures[car]) * exitSpeed
        } else {
          const approaching = newcomer < 0 ? 0 : Math.max(0, (joins[newcomer] - time) / approachTime)
          if (approaching >= 1) continue
          distance = front - car - approaching * visibleQueue
        }
        frame.cars.push({
          id: phase + '-' + arm + (newcomer < 0 ? '-q' + car : '-a' + newcomer),
          phase, arm, distance,
        })
      }
    }
  })
  return frame
}
