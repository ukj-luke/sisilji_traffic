import type { Box, Rect } from './metrics'

export type GrayFrame = {
  time: number
  width: number
  height: number
  pixels: Uint8Array
}
type Velocity = { vx: number; vy: number }
type StopReference = {
  box: Box
  offsets: Int32Array
  values: Uint8Array
  contrast: number
  mean: number
  since: number
  stable: boolean
  repeated: boolean
}
type KindVote = { time: number; kind: number; score: number }
type Track = Velocity & {
  votes?: KindVote[]
  appearance?: StopReference
  verifiedAt: number
  stop?: StopReference
  leftStop?: number
  id: number
  visualTime: number
  anchor?: { frame: GrayFrame; box: Box }
  lastSearch: number
  lastMotion: number
  box: Box
  detectionBox: Box
  detected: number
  confirmed: boolean
  queueHits: number
  lastQueueHit: number
}

export function grayscale(time: number, image: ImageData): GrayFrame {
  const pixels = new Uint8Array(image.width * image.height)
  for (let i = 0, k = 0; i < pixels.length; i++, k += 4) {
    pixels[i] =
      (image.data[k] * 77 + image.data[k + 1] * 150 + image.data[k + 2] * 29) >>
      8
  }
  return { time, width: image.width, height: image.height, pixels }
}

// 영상에서 관측한 밝기 무늬를 두 프레임에서 대조합니다. 대응되는 무늬가 없으면 추적을 종료합니다.
function shift(
  box: Box,
  prev: GrayFrame,
  next: GrayFrame,
  motion?: Velocity,
): Box | null {
  const { width, height } = prev
  const bw = box.w * width,
    bh = box.h * height
  if (bw < 3 || bh < 3) return null
  const x = Math.round((box.x + box.w / 2) * width),
    y = Math.round((box.y + box.h / 2) * height)
  const rx = Math.max(2, Math.floor(bw * 0.36)),
    ry = Math.max(2, Math.floor(bh * 0.36))
  if (x - rx < 0 || x + rx >= width || y - ry < 0 || y + ry >= height)
    return null
  const offsets: number[] = [],
    values: number[] = [],
    weights: number[] = []
  let totalWeight = 0
  for (let j = -2; j <= 2; j++)
    for (let i = -2; i <= 2; i++) {
      const offset =
        (y + Math.round((j * ry) / 2)) * width + x + Math.round((i * rx) / 2)
      offsets.push(offset)
      values.push(prev.pixels[offset])
      const contrast =
        Math.abs(
          prev.pixels[Math.min(prev.pixels.length - 1, offset + 1)] -
            prev.pixels[Math.max(0, offset - 1)],
        ) +
        Math.abs(
          prev.pixels[Math.min(prev.pixels.length - 1, offset + width)] -
            prev.pixels[Math.max(0, offset - width)],
        )
      const weight = 1 + Math.min(3, contrast / 36)
      weights.push(weight)
      totalWeight += weight
    }
  const range = Math.max(...values) - Math.min(...values)
  const radius = Math.min(
    18,
    Math.max(
      4,
      Math.ceil(
        (next.time - prev.time) * Math.min(220, 55 + 3 * Math.max(bw, bh)),
      ),
    ),
  )
  const dt = next.time - prev.time
  const px = Math.round(
    Math.max(-radius * 2, Math.min(radius * 2, (motion?.vx ?? 0) * dt * width)),
  )
  const py = Math.round(
    Math.max(
      -radius * 2,
      Math.min(radius * 2, (motion?.vy ?? 0) * dt * height),
    ),
  )
  const xmin = Math.max(px - radius, rx - x),
    xmax = Math.min(px + radius, width - 1 - rx - x)
  const ymin = Math.max(py - radius, ry - y),
    ymax = Math.min(py + radius, height - 1 - ry - y)
  function error(dx: number, dy: number) {
    const delta = dy * width + dx
    let sum = 0
    for (let k = 0; k < offsets.length; k++)
      sum +=
        weights[k] *
        Math.min(70, Math.abs(values[k] - next.pixels[offsets[k] + delta]))
    return sum / totalWeight + 0.1 * (Math.abs(dx - px) + Math.abs(dy - py))
  }
  let dx = 0,
    dy = 0,
    best = error(0, 0)
  if (best < 2) return box
  if (range < 13) return best < 5 ? box : null
  function check(i: number, j: number) {
    const cost = error(i, j)
    if (cost < best) {
      best = cost
      dx = i
      dy = j
    }
  }
  for (let j = ymin; j <= ymax; j += 2)
    for (let i = xmin; i <= xmax; i += 2) check(i, j)
  const coarseX = dx,
    coarseY = dy
  for (
    let j = Math.max(ymin, coarseY - 1);
    j <= Math.min(ymax, coarseY + 1);
    j++
  )
    for (
      let i = Math.max(xmin, coarseX - 1);
      i <= Math.min(xmax, coarseX + 1);
      i++
    )
      check(i, j)
  if (best > Math.min(29, 8 + range * 0.23)) return null
  return clipBox(box, box.x + dx / width, box.y + dy / height)
}

const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)]

// 차체의 여러 지점에서 이동량이 서로 맞는 무늬를 찾아 상자의 위치와 크기를 갱신합니다.
function followFeatures(
  box: Box,
  prev: GrayFrame,
  next: GrayFrame,
  motion?: Velocity,
) {
  const { width, height } = prev
  const w = box.w * width,
    h = box.h * height
  if (Math.min(w, h) < 8) return shift(box, prev, next, motion)
  const dt = next.time - prev.time
  const step = Math.min(3, Math.max(1, Math.round(Math.min(w, h) / 15)))
  const radius = Math.min(
    15,
    Math.max(4, Math.ceil(dt * (50 + 2 * Math.max(w, h)))),
  )
  const px = Math.round(
    Math.max(-2 * radius, Math.min(2 * radius, (motion?.vx ?? 0) * dt * width)),
  )
  const py = Math.round(
    Math.max(
      -2 * radius,
      Math.min(2 * radius, (motion?.vy ?? 0) * dt * height),
    ),
  )
  const offsets = [
    -step * width - step,
    -step * width,
    -step * width + step,
    -step,
    0,
    step,
    step * width - step,
    step * width,
    step * width + step,
  ]
  const votes: { x: number; y: number; dx: number; dy: number }[] = []
  for (const v of [0.23, 0.5, 0.77])
    for (const u of [0.23, 0.5, 0.77]) {
      const x = Math.round(box.x * width + w * u),
        y = Math.round(box.y * height + h * v)
      if (x < step || y < step || x + step >= width || y + step >= height)
        continue
      const center = y * width + x
      const sample = offsets.map((i) => prev.pixels[center + i])
      const contrast = Math.max(...sample) - Math.min(...sample)
      if (contrast < 18) continue
      const lowX = Math.max(step - x, px - radius),
        highX = Math.min(width - 1 - step - x, px + radius)
      const lowY = Math.max(step - y, py - radius),
        highY = Math.min(height - 1 - step - y, py + radius)
      let best = Infinity,
        dx = 0,
        dy = 0
      function check(a: number, b: number) {
        if (a < lowX || a > highX || b < lowY || b > highY) return
        let error = 0
        const at = center + b * width + a
        for (let k = 0; k < offsets.length; k++)
          error += Math.min(
            60,
            Math.abs(sample[k] - next.pixels[at + offsets[k]]),
          )
        const cost = error / offsets.length + 0.22 * Math.hypot(a - px, b - py)
        if (cost < best) {
          best = cost
          dx = a
          dy = b
        }
      }
      check(px, py)
      check(0, 0)
      if (best > 1) {
        for (let b = py - 3; b <= py + 3; b++)
          for (let a = px - 3; a <= px + 3; a++) check(a, b)
      }
      if (best > 2) {
        for (let b = lowY; b <= highY; b += 2)
          for (let a = lowX; a <= highX; a += 2) check(a, b)
        const ax = dx,
          ay = dy
        for (let b = ay - 1; b <= ay + 1; b++)
          for (let a = ax - 1; a <= ax + 1; a++) check(a, b)
      }
      if (best < Math.min(22, 6 + contrast * 0.15)) votes.push({ x, y, dx, dy })
    }
  if (votes.length < 3) return shift(box, prev, next, motion)
  const mx = median(votes.map((p) => p.dx)),
    my = median(votes.map((p) => p.dy))
  const agreed = votes.filter(
    (p) =>
      Math.hypot(p.dx - mx, p.dy - my) <= Math.max(2.5, Math.min(w, h) * 0.12),
  )
  if (agreed.length < 3 || agreed.length * 2 < votes.length)
    return shift(box, prev, next, motion)
  const scales: number[] = []
  for (let i = 0; i < agreed.length; i++)
    for (let j = 0; j < i; j++) {
      const a = agreed[i],
        b = agreed[j],
        x = a.x - b.x,
        y = a.y - b.y
      const length = Math.hypot(x, y)
      if (length >= 0.4 * Math.min(w, h))
        scales.push(Math.hypot(x + a.dx - b.dx, y + a.dy - b.dy) / length)
    }
  const scale =
    scales.length >= 3
      ? Math.max(1 - dt * 0.9, Math.min(1 + dt * 0.9, median(scales)))
      : 1
  const bw = box.w * scale,
    bh = box.h * scale
  const x = box.x + median(agreed.map((p) => p.dx)) / width + (box.w - bw) / 2
  const y = box.y + median(agreed.map((p) => p.dy)) / height + (box.h - bh) / 2
  return clipBox(box, x, y, bw, bh)
}

function matchScore(a: Rect, b: Rect) {
  const overlap =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return overlap / (a.w * a.h + b.w * b.h - overlap)
}

export function sameVehicle(a: Rect, b: Rect) {
  const shared =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const iou = shared / (a.w * a.h + b.w * b.h - shared)
  const centerGap = Math.hypot(
    (a.x + a.w / 2 - b.x - b.w / 2) / Math.max(a.w, b.w),
    (a.y + a.h / 2 - b.y - b.h / 2) / Math.max(a.h, b.h),
  )
  return (
    iou > 0.4 ||
    (centerGap < 0.35 && shared > 0.72 * Math.min(a.w * a.h, b.w * b.h))
  )
}

function appearanceOffset(box: Rect, width: number, height: number, i: number) {
  const x = Math.floor((box.x + box.w * (0.14 + (0.72 * (i % 8)) / 7)) * width)
  const y = Math.floor(
    (box.y + box.h * (0.1 + (0.8 * Math.floor(i / 8)) / 7)) * height,
  )
  return (
    Math.min(height - 2, Math.max(0, y)) * width +
    Math.min(width - 2, Math.max(0, x))
  )
}

// 검출 시점의 차체 무늬를 같은 화면 좌표에서 대조합니다. 기준을 매 프레임 덮어쓰면
// 천천히 출발한 차량 대신 그 자리에 드러난 노면을 계속 추적할 수 있습니다.
function stopReference(box: Box, frame: GrayFrame): StopReference | undefined {
  const { width, height, pixels } = frame
  if (box.w * width < 6 || box.h * height < 7) return
  const offsets = new Int32Array(64),
    values = new Uint8Array(64)
  let sum = 0,
    squares = 0
  for (let i = 0; i < 64; i++) {
    const k = appearanceOffset(box, width, height, i)
    offsets[i] = k
    const v =
      (pixels[k] + pixels[k + 1] + pixels[k + width] + pixels[k + width + 1]) >>
      2
    values[i] = v
    sum += v
    squares += v * v
  }
  const contrast = Math.sqrt(squares / 64 - (sum / 64) ** 2)
  if (contrast < 7) return
  return {
    box,
    offsets,
    values,
    contrast,
    mean: sum / 64,
    since: frame.time,
    stable: false,
    repeated: false,
  }
}

function stillPresent(
  ref: StopReference,
  frame: GrayFrame,
  dx = 0,
  dy = 0,
  resized?: Rect,
) {
  const { pixels, width, height } = frame
  if (dx || dy) {
    const first = ref.offsets[0],
      last = ref.offsets[63]
    if (
      (first % width) + dx < 0 ||
      (last % width) + dx >= width - 1 ||
      Math.floor(first / width) + dy < 0 ||
      Math.floor(last / width) + dy >= height - 1
    )
      return false
  }
  let sum = 0,
    squares = 0,
    cross = 0,
    outliers = 0
  const limit = Math.max(18, Math.min(42, ref.contrast * 0.75))
  for (let i = 0; i < ref.offsets.length; i++) {
    const k = resized
      ? appearanceOffset(resized, width, height, i)
      : ref.offsets[i] + dy * width + dx
    const value =
      (pixels[k] + pixels[k + 1] + pixels[k + width] + pixels[k + width + 1]) >>
      2
    const delta = value - ref.values[i]
    if (Math.abs(delta) > limit && ++outliers > 14) return false
    sum += delta
    squares += delta * delta
    cross += delta * (ref.values[i] - ref.mean)
  }
  const bias = sum / 64
  const variance = ref.contrast ** 2
  const gain = 1 + cross / (64 * variance)
  const residual = squares / 64 - bias * bias - (gain - 1) ** 2 * variance
  return (
    Math.abs(bias) <= 18 &&
    gain >= 0.7 &&
    gain <= 1.4 &&
    residual <= Math.max(6, Math.min(18, ref.contrast * 0.31)) ** 2
  )
}

// 고정 CCTV의 미세한 흔들림은 처음 위치를 기준으로 한 픽셀까지만 허용합니다.
function sameStop(ref: StopReference, frame: GrayFrame, dx = 0, dy = 0) {
  if (stillPresent(ref, frame, dx, dy)) return true
  for (let y = -1; y <= 1; y++)
    for (let x = -1; x <= 1; x++) {
      if ((x || y) && stillPresent(ref, frame, dx + x, dy + y)) return true
    }
  return false
}

// 정지 위치에서 조금씩 출발하면 직전 프레임 사이의 이동량보다 누적 이동량이 큽니다.
function leavingBox(ref: StopReference, frame: GrayFrame, optical: Box | null) {
  const { box } = ref
  if (optical) {
    const dx = Math.round(
      (optical.x + optical.w / 2 - box.x - box.w / 2) * frame.width,
    )
    const dy = Math.round(
      (optical.y + optical.h / 2 - box.y - box.h / 2) * frame.height,
    )
    if ((dx || dy) && sameStop(ref, frame, dx, dy)) return optical
  }
  const limit = Math.min(
    5,
    Math.floor(0.25 * Math.min(box.w * frame.width, box.h * frame.height)),
  )
  for (let radius = 2; radius <= limit; radius++) {
    for (let y = -radius; y <= radius; y++)
      for (let x = -radius; x <= radius; x++) {
        if (
          Math.max(Math.abs(x), Math.abs(y)) !== radius ||
          !stillPresent(ref, frame, x, y)
        )
          continue
        const next = {
          ...box,
          x: box.x + x / frame.width,
          y: box.y + y / frame.height,
        }
        if (
          next.x >= 0 &&
          next.y >= 0 &&
          next.x + next.w <= 1 &&
          next.y + next.h <= 1
        )
          return next
      }
  }
  return null
}

function coversTwoStops(box: Rect, stopped: Track[]) {
  let first: Rect | undefined
  for (const t of stopped) {
    const r = t.box
    const sharedW = Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x)
    const sharedH = Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y)
    if (
      sharedW < 0.7 * r.w ||
      sharedH < 0.7 * r.h ||
      box.w * box.h < 1.45 * r.w * r.h
    )
      continue
    if (first && matchScore(first, r) < 0.15) return true
    first = r
  }
  return false
}

function stopLifetime(ref: StopReference) {
  return ref.repeated ? Infinity : 2.2
}

function moving(track: Track) {
  return Math.hypot(track.vx / track.box.w, track.vy / track.box.h) > 0.45
}

// 화면 전체의 명암만 변했을 때 차체 무늬를 직전 프레임과 같은 밝기 척도에서 비교합니다.
function compensateExposure(
  prev: GrayFrame,
  frame: GrayFrame,
): GrayFrame | null {
  let n = 0,
    oldSum = 0,
    newSum = 0,
    oldSquares = 0,
    newSquares = 0,
    products = 0
  for (let i = 0; i < frame.pixels.length; i += 191) {
    const a = prev.pixels[i],
      b = frame.pixels[i]
    n++
    oldSum += a
    newSum += b
    oldSquares += a * a
    newSquares += b * b
    products += a * b
  }
  const oldVariance = oldSquares - (oldSum * oldSum) / n,
    newVariance = newSquares - (newSum * newSum) / n
  const covariance = products - (oldSum * newSum) / n
  if (
    oldVariance < 64 * n ||
    newVariance < 64 * n ||
    covariance <= 0 ||
    covariance * covariance < 0.96 ** 2 * newVariance * oldVariance
  )
    return null
  const gain = covariance / newVariance,
    bias = (oldSum - gain * newSum) / n
  if (gain < 0.5 || gain > 2 || Math.abs(bias) > 110) return null
  const lut = Uint8ClampedArray.from({ length: 256 }, (_, i) => gain * i + bias)
  const pixels = new Uint8Array(frame.pixels.length)
  for (let i = 0; i < pixels.length; i++) pixels[i] = lut[frame.pixels[i]]
  return { ...frame, pixels }
}

function clipBox(
  box: Box,
  x: number,
  y: number,
  w = box.w,
  h = box.h,
): Box | null {
  if (w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1)
    return { ...box, x, y, w, h }
  const left = Math.max(0, x),
    top = Math.max(0, y)
  const width = Math.min(1, x + w) - left,
    height = Math.min(1, y + h) - top
  return width > 0 && height > 0
    ? { ...box, x: left, y: top, w: width, h: height }
    : null
}

function projectedBox(box: Box, motion: Velocity, dt: number) {
  const x = box.x + dt * motion.vx,
    y = box.y + dt * motion.vy
  return clipBox(box, x, y)
}

// 전체 화면과 확대 검사는 같은 영상 시각에 한 표만 냅니다.
function classify(box: Box, time: number, track?: Track) {
  const votes = (track?.votes ?? []).filter((v) => time >= v.time).slice(-7)
  const last = votes.at(-1)
  const vote = { time, kind: box.kind, score: box.score }
  if (last?.time !== time) votes.push(vote)
  else if (vote.score > last.score) votes[votes.length - 1] = vote
  if (votes.length > 7) votes.shift()
  const prior = track?.box.kind ?? -1
  const support = votes.filter((v) => v.kind === box.kind && v.score >= 0.28)
  const weight = (list: KindVote[]) => list.reduce((n, v) => n + v.score, 0)
  const other = votes.filter((v) => v.kind !== box.kind)
  const kind =
    (prior < 0 && box.score >= 0.75 && votes.length === 1) ||
    (support.length >= (prior < 0 ? 2 : 4) &&
      weight(support) > 1.45 * weight(other))
      ? box.kind
      : prior
  return { votes, kind }
}

export class FrameFollower {
  private nextId = 1
  private readonly trackMotion: boolean
  private readonly occluder?: Rect
  constructor(trackMotion = false, occluder?: Rect) {
    this.occluder = occluder
    this.trackMotion = trackMotion
  }
  private frames: GrayFrame[] = []
  private tracks: Track[] = []
  private missing = new Map<
    number,
    { track: Track; lostAt: number; behindSign: boolean }
  >()
  // 가림이 풀린 차량은 위치와 차체 무늬를 모두 대조해 이전 번호에 연결합니다.
  private rememberMissing(previous: Track[], time: number) {
    if (!this.trackMotion) return
    const active = new Set(this.tracks.map((t) => t.id))
    for (const t of previous) {
      if (
        t.confirmed &&
        t.appearance &&
        !active.has(t.id) &&
        !this.tracks.some((u) => sameVehicle(t.box, u.box))
      ) {
        const origin = t.anchor?.box ?? t.box
        const next = projectedBox(origin, t, 0.35)
        const behindSign =
          !!this.occluder &&
          moving(t) &&
          (matchScore(this.occluder, origin) > 0 ||
            (!!next && matchScore(this.occluder, next) > 0))
        this.missing.set(t.id, {
          track: { ...t, box: origin },
          lostAt: time,
          behindSign,
        })
      }
    }
    for (const [id, entry] of this.missing)
      if (time - entry.lostAt > (entry.behindSign ? 3 : 1.2) || active.has(id))
        this.missing.delete(id)
  }
  private reacquire(box: Box, frame: GrayFrame): Track | undefined {
    let best = 0.28,
      chosen: Track | undefined
    let runnerUp = 0
    for (const { track, lostAt, behindSign } of this.missing.values()) {
      const age = frame.time - lostAt
      if (age < 0 || age > (behindSign ? 3 : 1.2) || !track.appearance) continue
      const predicted = projectedBox(
        track.box,
        track,
        Math.min(
          behindSign ? 3 : 0.8,
          Math.max(0, frame.time - track.visualTime),
        ),
      )
      const score = Math.max(
        matchScore(track.box, box),
        predicted ? matchScore(predicted, box) : 0,
      )
      if (score <= 0.18 || !stillPresent(track.appearance, frame, 0, 0, box))
        continue
      if (score > best) {
        runnerUp = chosen ? best : runnerUp
        best = score
        chosen = track
      } else runnerUp = Math.max(runnerUp, score)
    }
    if (chosen && runnerUp > best - 0.08) return
    if (chosen) this.missing.delete(chosen.id)
    return chosen
  }
  get continuationBoxes(): Rect[] {
    const boxes: Rect[] = this.tracks
      .filter((t) => t.confirmed)
      .map((t) => t.box)
    const time = this.frames.at(-1)?.time
    for (const { track, behindSign } of this.missing.values()) {
      const estimate =
        time === undefined
          ? null
          : projectedBox(
              track.box,
              track,
              Math.min(
                behindSign ? 3 : 0.8,
                Math.max(0, time - track.visualTime),
              ),
            )
      boxes.push(estimate ?? track.box)
    }
    return boxes
  }
  get visible() {
    return this.tracks
      .filter((t) => t.confirmed)
      .map((t) => (this.trackMotion ? { ...t.box, trackId: t.id } : t.box))
  }
  get observedVehicles() {
    const time = this.frames.at(-1)?.time
    return this.tracks
      .filter((t) => t.confirmed && !t.anchor && t.visualTime === time)
      .map((t) => ({ ...t.box, trackId: t.id }))
  }
  private probes: { time: number; box: Rect }[] = []
  private probeNew = true
  searchTarget(
    time: number,
    proposals?: (
      now: GrayFrame,
      recent: GrayFrame,
      earlier: GrayFrame,
    ) => Rect[],
  ): Rect | undefined {
    if (!this.trackMotion) return undefined
    let target: Track | undefined
    let highestPriority = 1
    for (const t of this.tracks) {
      const due = time - Math.max(t.detected, t.lastSearch)
      const interval = t.stop?.stable
        ? 0.85
        : time - t.lastMotion <= 0.35
          ? 0.18
          : Infinity
      const priority = due / interval
      if (t.confirmed && priority > highestPriority) {
        target = t
        highestPriority = priority
      }
    }
    if (proposals && (!target || this.probeNew)) {
      const frame = this.frames.at(-1)
      let recent: GrayFrame | undefined, earlier: GrayFrame | undefined
      for (const f of this.frames) {
        if (f.time <= time - 0.22) recent = f
        if (f.time <= time - 0.5) earlier = f
      }
      if (frame && recent && earlier) {
        this.probes = this.probes.filter((p) => time - p.time <= 0.45)
        const uncovered = proposals(frame, recent, earlier).find(
          (b) =>
            !this.tracks.some(
              (t) => t.confirmed && matchScore(t.box, b) > 0.16,
            ) && !this.probes.some((p) => matchScore(p.box, b) > 0.2),
        )
        if (uncovered) {
          this.probes.push({ time, box: uncovered })
          this.probeNew = false
          return uncovered
        }
      }
    }
    // 가려진 차의 예상 출구도 차량 모델로 확인합니다.
    if (!target || !this.probeNew) {
      const exit = [...this.missing.values()].find(
        ({ track, behindSign }) =>
          behindSign && time - track.lastSearch >= 0.35,
      )
      if (exit) {
        const predicted = projectedBox(
          exit.track.box,
          exit.track,
          time - exit.track.visualTime,
        )
        if (predicted) {
          exit.track.lastSearch = time
          this.probeNew = true
          return predicted
        }
      }
    }
    this.probeNew = true
    if (target) target.lastSearch = time
    return target?.box
  }
  has(time: number) {
    return this.frames.some((f) => f.time === time)
  }
  reset() {
    this.frames = []
    this.tracks = []
    this.missing.clear()
    this.probes = []
    this.probeNew = true
  }

  private reconnect(prev: GrayFrame, frame: GrayFrame, gap: number) {
    const recovered: Track[] = []
    for (const old of this.tracks) {
      if (!old.confirmed) continue
      const ref = old.stop?.stable
        ? old.stop
        : !old.anchor && prev.time - old.verifiedAt <= 0.5
          ? stopReference(old.box, prev)
          : old.appearance
      if (!ref) continue
      const predicted = projectedBox(
        old.box,
        old,
        Math.max(0, Math.min(gap, 0.8)),
      )
      let box: Box | null = null
      if (sameStop(ref, frame)) box = ref.box
      else if (predicted && stillPresent(ref, frame, 0, 0, predicted))
        box = predicted
      else box = leavingBox(ref, frame, predicted)
      if (!box || recovered.some((t) => matchScore(t.box, box!) > 0.55))
        continue
      const stayed = box === ref.box && old.stop?.stable
      const offset = Math.min(0, frame.time - prev.time)
      recovered.push({
        ...old,
        box: { ...box, kind: old.box.kind },
        detectionBox: box,
        anchor: undefined,
        stop: stayed ? { ...ref, since: ref.since + offset } : undefined,
        leftStop: undefined,
        detected: old.detected + offset,
        verifiedAt: frame.time,
        visualTime: frame.time,
        lastSearch: -Infinity,
        lastMotion: stayed ? -Infinity : frame.time,
        vx: 0,
        vy: 0,
        queueHits: 0,
        lastQueueHit: -Infinity,
      })
    }
    this.reset()
    this.tracks = recovered
  }

  push(frame: GrayFrame, discontinuity = false) {
    let cut = false
    const prev = this.frames.at(-1)
    const priorTracks = this.tracks
    if (prev) {
      const gap = frame.time - prev.time
      if (prev.width !== frame.width || prev.height !== frame.height) {
        this.reset()
        cut = true
      } else {
        let changed = 0,
          sampled = 0
        for (let i = 0; i < frame.pixels.length; i += 191) {
          sampled++
          if (Math.abs(frame.pixels[i] - prev.pixels[i]) > 38) changed++
        }
        const sceneChanged = changed > sampled * 0.48
        const corrected =
          sceneChanged && this.trackMotion
            ? compensateExposure(prev, frame)
            : null
        if (corrected) frame = corrected
        if (sceneChanged && !corrected) {
          this.reset()
          cut = true
        } else if (
          discontinuity ||
          gap <= 0 ||
          gap > (this.trackMotion ? 0.45 : 0.28)
        ) {
          if (this.trackMotion) this.reconnect(prev, frame, gap)
          else this.reset()
          cut = true
        } else
          this.tracks = this.tracks.flatMap((t) => {
            let leaving: StopReference | undefined
            if (t.stop) {
              if (sameStop(t.stop, frame)) {
                if (frame.time - t.stop.since >= 0.2) {
                  if (frame.time - t.detected > stopLifetime(t.stop)) return []
                  t.stop.stable = true
                  return [
                    {
                      ...t,
                      box: { ...t.stop.box, kind: t.box.kind },
                      anchor: undefined,
                      visualTime: frame.time,
                      verifiedAt: frame.time,
                      vx: 0,
                      vy: 0,
                      lastMotion: -Infinity,
                    },
                  ]
                }
              } else {
                if (t.stop.stable) leaving = t.stop
                t = { ...t, stop: undefined }
              }
            }
            const inMotion =
              this.trackMotion &&
              t.confirmed &&
              frame.time - t.lastMotion <= 0.35
            const lastEvidence = Math.max(t.detected, t.leftStop ?? -Infinity)
            if (!this.trackMotion && frame.time - lastEvidence > 0.72) return []
            let box = this.trackMotion
              ? followFeatures(
                  t.anchor?.box ?? t.box,
                  t.anchor?.frame ?? prev,
                  frame,
                  t,
                )
              : shift(t.box, prev, frame)
            if (leaving) box = leavingBox(leaving, frame, box)
            if (!box) {
              if (!inMotion || frame.time - t.visualTime > 0.22) return []
              const predicted = projectedBox(t.box, t, gap)
              return predicted
                ? [
                    {
                      ...t,
                      box: predicted,
                      anchor: t.anchor ?? { frame: prev, box: t.box },
                    },
                  ]
                : []
            }
            if (!this.trackMotion) return [{ ...t, box }]
            const matched =
              t.confirmed &&
              t.appearance &&
              stillPresent(t.appearance, frame, 0, 0, box)
            const verifiedAt = matched ? frame.time : t.verifiedAt
            if (
              !leaving &&
              frame.time - Math.max(lastEvidence, verifiedAt) >
                (inMotion ? 2.2 : 0.72)
            )
              return []
            const dx = box.x - t.box.x + (box.w - t.box.w) / 2,
              dy = box.y - t.box.y + (box.h - t.box.h) / 2
            const movingNow = Math.hypot(dx / box.w, dy / box.h) > 0.4 * gap
            const movedSinceDetection = Math.hypot(
              (box.x + box.w / 2 - t.detectionBox.x - t.detectionBox.w / 2) /
                box.w,
              (box.y + box.h / 2 - t.detectionBox.y - t.detectionBox.h / 2) /
                box.h,
            )
            const consistentMotion =
              movingNow &&
              frame.time - t.detected >= 0.12 &&
              prev.time - t.lastMotion <= 0.12 &&
              dx * t.vx + dy * t.vy > 0 &&
              movedSinceDetection > 0.3
            return [
              {
                ...t,
                box: { ...box, kind: t.box.kind },
                confirmed: t.confirmed || consistentMotion,
                verifiedAt,
                leftStop: leaving ? frame.time : t.leftStop,
                anchor: undefined,
                visualTime: frame.time,
                lastMotion: movingNow ? frame.time : t.lastMotion,
                vx: 0.55 * t.vx + (0.45 * dx) / gap,
                vy: 0.55 * t.vy + (0.45 * dy) / gap,
              },
            ]
          })
      }
    }
    if (!cut) this.rememberMissing(priorTracks, frame.time)
    this.frames.push(frame)
    while (this.frames[0].time < frame.time - 0.95) this.frames.shift()
    return cut
  }

  observe(
    boxes: Box[],
    time: number,
    complete: boolean,
    queueView = false,
    queueScanned = false,
  ) {
    const index = this.frames.findIndex((f) => f.time === time)
    if (index < 0) return []
    const latest = this.frames.at(-1)!.time
    const used = new Set<number>(),
      fresh: Track[] = [],
      measured: Box[] = []
    const stopped = this.tracks.filter((t) => t.stop?.stable)
    for (const b of boxes) {
      if (stopped.length >= 2 && coversTwoStops(b, stopped)) continue
      let projected: Box | null = b
      let seed: Track | undefined
      if (this.trackMotion) {
        let best = 0.3
        for (const t of this.tracks) {
          const elapsed = time - t.detected
          if (elapsed < 0 || elapsed > 1.15) continue
          const atSource = projectedBox(t.detectionBox, t, elapsed)
          const score = atSource ? matchScore(b, atSource) : 0
          if (score > best) {
            seed = t
            best = score
          }
        }
      }
      // 전체 화면과 확대 검사가 같은 원본 상자를 돌려주면 이미 추적한 위치를 재사용합니다.
      if (seed?.detected === time && matchScore(seed.detectionBox, b) > 0.995)
        projected = seed.box
      else
        for (let i = index + 1; i < this.frames.length && projected; i++)
          projected = this.trackMotion
            ? followFeatures(
                projected,
                this.frames[i - 1],
                this.frames[i],
                seed,
              )
            : shift(projected, this.frames[i - 1], this.frames[i])
      const predicted =
        !projected && seed?.confirmed && latest - time <= 0.22 && moving(seed)
          ? projectedBox(b, seed, latest - time)
          : null
      if (predicted) projected = predicted
      if (
        !projected &&
        queueView &&
        b.queueCandidate &&
        latest - time <= 0.35 &&
        index < this.frames.length - 2
      )
        projected = shift(
          b,
          this.frames[index],
          this.frames[this.frames.length - 1],
        )
      const strong = b.score >= 0.28
      if (!projected) {
        if (strong && (!b.inTransit || seed?.confirmed)) measured.push(b)
        continue
      }
      let best = this.trackMotion ? 0.22 : 0.32,
        match = -1
      this.tracks.forEach((t, i) => {
        if (used.has(i)) return
        const overlap = matchScore(t.box, projected!)
        const score =
          this.trackMotion && sameVehicle(t.box, projected!)
            ? Math.max(0.4, overlap)
            : overlap
        if (score > best) {
          best = score
          match = i
        }
      })
      const previous =
        this.tracks[match] ??
        (this.trackMotion
          ? this.reacquire(projected, this.frames[this.frames.length - 1])
          : undefined)
      const moved =
        previous &&
        Math.hypot(
          b.x +
            b.w / 2 -
            (previous.detectionBox.x + previous.detectionBox.w / 2),
          b.y +
            b.h / 2 -
            (previous.detectionBox.y + previous.detectionBox.h / 2),
        ) >
          0.1 * Math.min(b.w, b.h)
      const queueHit = queueView && complete && b.queueCandidate === true
      const recent =
        previous &&
        time - previous.lastQueueHit <= 0.65 &&
        matchScore(previous.detectionBox, b) >= 0.5
      const priorHits = recent ? previous.queueHits : 0
      const queueHits =
        queueHit && previous?.lastQueueHit !== time ? priorHits + 1 : priorHits
      const lastQueueHit = queueHit
        ? time
        : (previous?.lastQueueHit ?? -Infinity)
      const confirmed =
        (queueHit && queueHits >= 3) ||
        (strong && !b.inTransit) ||
        (!!previous &&
          (previous.confirmed ||
            (previous.detected < time &&
              !!moved &&
              (!b.inTransit || latest - previous.lastMotion <= 0.25))))
      if (match >= 0) used.add(match)
      if (confirmed) measured.push(b)
      const dt = previous ? time - previous.detected : 0
      const velocity = (axis: 'x' | 'y', size: 'w' | 'h', prior: number) => {
        if (!this.trackMotion || !previous || dt < 0.04) return prior
        const old = previous.detectionBox
        const measured = (b[axis] - old[axis] + (b[size] - old[size]) / 2) / dt
        return prior * 0.45 + measured * 0.55
      }
      let stop = previous?.stop
      if (stop && (b.inTransit || matchScore(projected, stop.box) < 0.38))
        stop = undefined
      if (
        stop &&
        time - stop.since >= 0.2 &&
        previous &&
        time > previous.detected
      )
        stop.repeated = true
      const appearance =
        this.trackMotion && confirmed
          ? stopReference(b, this.frames[index])
          : undefined
      if (!stop && appearance && !b.inTransit) {
        const ref = appearance
        if (sameStop(ref, this.frames[this.frames.length - 1])) {
          ref.stable = latest - time >= 0.2
          stop = ref
        }
      }
      const classification = this.trackMotion
        ? classify(b, time, previous)
        : undefined
      const position = stop?.stable ? stop.box : projected
      fresh.push({
        votes: classification?.votes,
        appearance: appearance ?? previous?.appearance,
        verifiedAt: latest,
        stop,
        leftStop: previous?.leftStop,
        id: previous?.id ?? this.nextId++,
        visualTime: predicted ? time : latest,
        lastSearch: previous?.lastSearch ?? -Infinity,
        lastMotion: stop?.stable
          ? -Infinity
          : moved && dt > 0 && !b.inTransit
            ? Math.max(time, previous?.lastMotion ?? -Infinity)
            : (previous?.lastMotion ?? -Infinity),
        vx: stop?.stable ? 0 : velocity('x', 'w', previous?.vx ?? 0),
        vy: stop?.stable ? 0 : velocity('y', 'h', previous?.vy ?? 0),
        box: classification
          ? { ...position, kind: classification.kind }
          : position,
        detectionBox: b,
        detected: time,
        confirmed,
        queueHits,
        lastQueueHit,
      })
    }
    const carry = this.tracks.filter((t, i) => {
      if (used.has(i)) return false
      const parked = t.stop?.stable
      const inMotion =
        this.trackMotion && t.confirmed && latest - t.lastMotion <= 0.35
      const lastEvidence = inMotion
        ? Math.max(t.detected, t.leftStop ?? -Infinity)
        : t.detected
      const lifetime =
        t.stop && parked
          ? stopLifetime(t.stop)
          : inMotion
            ? 2.2
            : queueView && t.queueHits > 0 && !queueScanned
              ? 0.65
              : complete
                ? 0.3
                : 0.6
      return (
        latest -
          (t.confirmed && this.trackMotion && !parked
            ? Math.max(lastEvidence, t.verifiedAt)
            : lastEvidence) <
          lifetime &&
        !fresh.some(
          (f) =>
            (this.trackMotion && sameVehicle(f.box, t.box)) ||
            matchScore(f.box, t.box) >
              (parked ||
              (this.trackMotion && t.confirmed && t.verifiedAt === latest)
                ? 0.55
                : 0.24),
        )
      )
    })
    const priorTracks = this.tracks
    this.tracks = [...fresh, ...carry]
    this.rememberMissing(priorTracks, latest)
    return measured
  }
}
