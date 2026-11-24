export type Point = [number, number]
export type Quad = [Point, Point, Point, Point]
// 먼 쪽 왼쪽에서 시작해 오른쪽 경계를 따라 내려오고, 왼쪽 경계로 돌아오는 순서입니다.
export type Lane = [Point, Point, Point, Point, ...Point[]]
export type LaneLabel = { direction: string; movement: string }
export type Rect = {
  x: number
  y: number
  w: number
  h: number
}
export type Box = Rect & {
  kind: number
  trackId?: number
  inTransit?: boolean
  queueCandidate?: boolean
  score: number
}
export type Sample = { time: number; occupancy: (number | null)[] }
export const vehicleNames: Record<number, string> = {
  2: '승용차',
  3: '이륜차',
  5: '버스',
  7: '화물차',
}

const sectionsByLane = new WeakMap<Lane, Quad[]>()

export function laneSections(lane: Lane): Quad[] {
  const cached = sectionsByLane.get(lane)
  if (cached) return cached
  const parts: Quad[] = []
  for (let i = 0; i < lane.length / 2 - 1; i++) {
    const left = i === 0 ? lane[0] : lane[lane.length - i]
    parts.push([left, lane[i + 1], lane[i + 2], lane[lane.length - i - 1]])
  }
  sectionsByLane.set(lane, parts)
  return parts
}

function inQuad(x: number, y: number, lane: Quad) {
  let positive = false,
    negative = false
  for (let i = 0; i < 4; i++) {
    const [a, b] = lane[i],
      [c, d] = lane[(i + 1) % 4]
    const side = (c - a) * (y - b) - (d - b) * (x - a)
    positive ||= side > 1e-8
    negative ||= side < -1e-8
  }
  return !(positive && negative)
}

export function inLane(x: number, y: number, lane: Lane) {
  return laneSections(lane).some((part) => inQuad(x, y, part))
}

// 화면에 그리는 차량마다 한 차로를 배정하고, 차로 분기 전의 후방 접근로는 따로 셉니다.
export type VehicleMotion = Map<number, { lane: number; slow: boolean }>
export function countVisibleVehicles(
  lanes: Lane[],
  boxes: Box[],
  rear?: Lane,
  motion?: VehicleMotion,
) {
  const observed = Array<number>(lanes.length + Number(!!rear)).fill(0)
  const slow = observed.slice()
  const counts = lanes.map(() => 0)
  let rearCount = 0
  const locations = boxes.map((box) => {
    const x = box.x + box.w / 2,
      y = box.y + box.h * 0.94
    const lane = lanes.findIndex((l) => inLane(x, y, l))
    const inRear = lane < 0 && !!rear && inLane(x, y, rear)
    if (lane >= 0) counts[lane]++
    if (inRear) rearCount++
    const index = inRear ? lanes.length : lane
    const result =
      box.trackId === undefined ? undefined : motion?.get(box.trackId)
    if (result && result.lane === index && index >= 0) {
      observed[index]++
      if (result.slow) slow[index]++
    }
    return { lane, inRear }
  })
  return { locations, counts, rearCount, observed, slow }
}

// 꺾이는 차로도 6구간과 한 집계를 공유합니다. 도로 폭 변화로 영상 원근을 보정합니다.
export function measure(
  lanes: Lane[],
  boxes: Box[],
  aspect: number,
  widthReferences?: Record<number, number>,
) {
  const width = (a: Point, b: Point) =>
    Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1])
  // 전용 차로가 갈라지는 지점에서는 나란히 이어지는 직진 차로의 폭으로 원근을 구합니다.
  function widthAt(lane: Lane, y: number) {
    const sections = laneSections(lane)
    for (const [a, b, c, d] of sections) {
      const start = (a[1] + b[1]) / 2,
        end = (c[1] + d[1]) / 2
      if (y <= end) {
        const t = Math.max(0, (y - start) / Math.max(1e-8, end - start))
        return width(a, b) * (1 - t) + width(c, d) * t
      }
    }
    const [, , c, d] = sections[sections.length - 1]
    return width(c, d)
  }
  const geometry = lanes.map((lane, i) => {
    const referenceIndex = widthReferences?.[i]
    const reference =
      referenceIndex === undefined ? undefined : lanes[referenceIndex]
    const parts = laneSections(lane).map((quad) => {
      const [a, b, c, d] = quad,
        fx = (a[0] + b[0]) / 2,
        fy = (a[1] + b[1]) / 2
      const dx = ((c[0] + d[0]) / 2 - fx) * aspect,
        dy = (c[1] + d[1]) / 2 - fy
      const far = reference ? widthAt(reference, fy) : width(a, b),
        near = reference ? widthAt(reference, (c[1] + d[1]) / 2) : width(c, d)
      return {
        quad,
        fx,
        fy,
        dx,
        dy,
        far,
        near,
        length: Math.hypot(dx, dy) / Math.max(1e-8, far * near),
      }
    })
    return { parts, length: parts.reduce((sum, p) => sum + p.length, 0) }
  })
  const bins = lanes.map(() => new Set<number>()),
    counts = lanes.map(() => 0)
  const assignments = boxes.map((box) => {
    const x = box.x + box.w / 2,
      y = box.y + box.h * 0.94
    for (const [i, lane] of geometry.entries()) {
      let preceding = 0
      for (const p of lane.parts) {
        if (inQuad(x, y, p.quad)) {
          const t = Math.max(
            0,
            Math.min(
              1,
              ((x - p.fx) * aspect * p.dx + (y - p.fy) * p.dy) /
                Math.max(1e-8, p.dx * p.dx + p.dy * p.dy),
            ),
          )
          const local =
            (t * p.near) / Math.max(1e-8, p.far * (1 - t) + p.near * t)
          const depth =
            (preceding + local * p.length) / Math.max(1e-8, lane.length)
          bins[i].add(Math.min(5, Math.floor(depth * 6)))
          counts[i]++
          return i
        }
        preceding += p.length
      }
    }
    return -1
  })
  return { counts, assignments, occupancy: bins.map((bin) => bin.size / 6) }
}

export function windowPercent(samples: Sample[], lane: number) {
  let lastBad = samples.length - 1
  while (lastBad >= 0 && samples[lastBad].occupancy[lane] != null) lastBad--
  if (lastBad >= 0) samples = samples.slice(lastBad + 1)
  if (samples.length < 3) return null
  const duration = samples.at(-1)!.time - samples[0].time
  if (duration < 1.5) return null
  let integral = 0
  for (let i = 1; i < samples.length; i++) {
    integral +=
      ((samples[i].time - samples[i - 1].time) *
        (samples[i].occupancy[lane]! + samples[i - 1].occupancy[lane]!)) /
      2
  }
  return Math.round((100 * integral) / duration)
}

type Track = {
  trackId?: number
  lane: number
  x: number
  y: number
  scale: number
  time: number
  anchorX: number
  anchorY: number
  since: number
  slow?: boolean
}

// 한 화각에서 차량 바닥 중심이 얼마나 이동했는지 차량 크기에 비례해 비교합니다.
export class LaneMotion {
  private tracks: Track[] = []

  update(
    boxes: Box[],
    assignments: number[],
    time: number,
    aspect: number,
    laneCount: number,
  ) {
    const slow = Array<number>(laneCount).fill(0)
    const observed = Array<number>(laneCount).fill(0)
    const motionById: VehicleMotion = new Map()
    const old = this.tracks.filter(
      (t) => time >= t.time && time - t.time <= 1.25,
    )
    const current = boxes.map((b, i) => ({
      trackId: b.trackId,
      lane: assignments[i],
      x: (b.x + b.w / 2) * aspect,
      y: b.y + b.h * 0.94,
      scale: Math.max(0.012, Math.hypot(b.w * aspect, b.h)),
    }))
    const pairs: { index: number; previous: number; cost: number }[] = []
    current.forEach((v, index) => {
      if (v.lane < 0) return
      old.forEach((t, previous) => {
        if (t.lane !== v.lane) return
        if (v.trackId !== undefined && t.trackId !== undefined) {
          if (v.trackId === t.trackId) pairs.push({ index, previous, cost: 0 })
          return
        }
        const ratio = v.scale / t.scale
        if (ratio < 0.55 || ratio > 1.8) return
        const cost =
          Math.hypot(v.x - t.x, v.y - t.y) / Math.max(v.scale, t.scale)
        if (cost < Math.min(1.0, 0.22 + (time - t.time) * 1.8))
          pairs.push({ index, previous, cost })
      })
    })
    const used = new Set<number>(),
      matches = new Map<number, Track>()
    for (const p of pairs.sort((a, b) => a.cost - b.cost)) {
      if (matches.has(p.index) || used.has(p.previous)) continue
      matches.set(p.index, old[p.previous])
      used.add(p.previous)
    }
    this.tracks = old.filter((_, index) => !used.has(index))
    current.forEach((v, i) => {
      if (v.lane < 0) return
      const track = matches.get(i) ?? {
        ...v,
        time,
        anchorX: v.x,
        anchorY: v.y,
        since: time,
      }
      const elapsed = time - track.since
      if (elapsed >= 1.25) {
        const movement = Math.hypot(v.x - track.anchorX, v.y - track.anchorY)
        track.slow = movement / ((elapsed * (v.scale + track.scale)) / 2) < 0.3
        track.anchorX = v.x
        track.anchorY = v.y
        track.since = time
      }
      Object.assign(track, v, { time })
      this.tracks.push(track)
      if (track.slow !== undefined) {
        if (v.trackId !== undefined)
          motionById.set(v.trackId, { lane: v.lane, slow: track.slow })
        observed[v.lane]++
        if (track.slow) slow[v.lane]++
      }
    })
    return { slow, observed, motionById }
  }
}

export function congestionGrade(
  pct: number | null,
  readable: boolean,
  count: number,
  slow: number,
  observed: number,
  useQueue = false,
) {
  if (!readable) return '시야 불량'
  const queue = useQueue ? queueGrade(count, observed, slow, 4) : null
  if (queue === '높음') return '높음'
  if (queue === '보통' && (pct === null || pct < 60)) return '보통'
  if (pct === null) return '측정 중'
  if (pct === 0 && !count) return '검출 없음'
  if (pct < 30) return '낮음'
  if (pct < 60) return '보통'
  if (!observed || observed * 2 < count) return '흐름 확인 중'
  return slow * 2 >= observed ? '높음' : '보통'
}

// 한 차로의 대기 차량이 여러 차로로 나뉘는 경우를 위해 방향별 합계도 판정합니다.
export function queueGrade(
  count: number,
  observed: number,
  slow: number,
  high: number,
) {
  if (!count) return '차량 없음'
  if (!observed || observed * 2 < count) return '흐름 확인 중'
  if (slow >= high && slow * 2 >= count) return '높음'
  if (slow >= 2 && slow * 2 >= count) return '보통'
  return '낮음'
}
