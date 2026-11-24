import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm'
import wasmPath from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import runtimePath from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import modelPath from '../models/yolox-tiny-vehicles.onnx?url'
import {
  type Box,
  type Rect,
  type Lane,
  inLane,
  laneSections,
  vehicleNames,
} from './metrics'
import { sameVehicle } from './follow'
import { RearView } from './rear-view'
import { roadMarkingFilter } from './road-markings'
import { prepareLandmarks } from './landmarks'

import type { DetectorInput as Frame } from './detector'
type Crop = {
  x: number
  y: number
  w: number
  h: number
  brighten?: boolean
  queueDetail?: boolean
  target?: Rect
}
const size = 416
const lift = Uint8Array.from({ length: 256 }, (_, i) =>
  Math.round(255 * (i / 255) ** 0.78),
)
const linear = Uint8Array.from({ length: 256 }, (_, i) => i)
const plane = size * size
const input = new Float32Array(3 * plane)
env.wasm.numThreads = 1
env.wasm.wasmPaths = {
  wasm: new URL(wasmPath, self.location.origin).href,
  mjs: new URL(runtimePath, self.location.origin).href,
}

function signature({ pixels, width, height }: Frame) {
  const result = new Uint8Array(280)
  let min = 255,
    max = 0
  for (let i = 0; i < 280; i++) {
    let total = 0
    for (let v = 0; v < 4; v++)
      for (let u = 0; u < 4; u++) {
        const x = Math.floor(
          width * (0.04 + (0.92 * ((i % 20) + (u + 0.5) / 4)) / 20),
        )
        const y = Math.floor(
          height * (0.08 + (0.74 * (Math.floor(i / 20) + (v + 0.5) / 4)) / 14),
        )
        const k = (y * width + x) * 4
        total +=
          pixels[k] * 0.299 + pixels[k + 1] * 0.587 + pixels[k + 2] * 0.114
      }
    result[i] = Math.round(total / 16)
    min = Math.min(min, result[i])
    max = Math.max(max, result[i])
  }
  return { signature: result, visible: max - min > 24 }
}

// 표본 위치를 차로 사각형 안에서 보간해 어둠과 과다 노출을 확인합니다.
function laneReadable(frame: Frame, lane: Lane) {
  const sections = laneSections(lane)
  let dark = 0,
    glare = 0
  for (let i = 0; i < 20; i++)
    for (let j = 0; j < 10; j++) {
      const along = ((i + 0.5) * sections.length) / 20
      const [a, b, c, d] = sections[Math.floor(along)]
      const t = along % 1,
        s = (j + 0.5) / 10
      const position = (k: number) =>
        a[k] * (1 - s) * (1 - t) +
        b[k] * s * (1 - t) +
        c[k] * s * t +
        d[k] * (1 - s) * t
      const x = Math.min(
          frame.width - 1,
          Math.floor(position(0) * frame.width),
        ),
        y = Math.min(frame.height - 1, Math.floor(position(1) * frame.height))
      const k = (y * frame.width + x) * 4
      const luma =
        frame.pixels[k] * 0.299 +
        frame.pixels[k + 1] * 0.587 +
        frame.pixels[k + 2] * 0.114
      if (luma > 220) glare++
      if (luma < 22) dark++
    }
  return glare < 44 && dark < 145
}

function inputFor(frame: Frame, crop: Crop) {
  const scale = size / Math.max(crop.w, crop.h)
  const w = Math.floor(crop.w * scale),
    h = Math.floor(crop.h * scale)
  const tone = crop.brighten ? lift : linear
  input.fill(114)
  for (let y = 0; y < h; y++) {
    const row =
      Math.min(frame.height - 1, Math.floor(crop.y + (y + 0.5) / scale)) *
      frame.width
    for (let x = 0; x < w; x++) {
      const source =
        4 *
        (row +
          Math.min(frame.width - 1, Math.floor(crop.x + (x + 0.5) / scale)))
      const dest = y * size + x
      // 이 배포 모델은 0~255 BGR 입력과 좌상단 정렬 패딩을 사용합니다.
      input[dest] = tone[frame.pixels[source + 2]]
      input[plane + dest] = tone[frame.pixels[source + 1]]
      input[2 * plane + dest] = tone[frame.pixels[source]]
    }
  }
  return scale
}

async function detect(session: InferenceSession, frame: Frame, crop: Crop) {
  const rear = crop.queueDetail
    ? new RearView(frame.width, frame.height, size)
    : undefined
  const scale = rear ? 1 : inputFor(frame, crop)
  rear?.write(frame.pixels, input)
  const tensor = new Tensor('float32', input, [1, 3, size, size])
  const outputs = await session.run({ images: tensor })
  const output = outputs.output
  const values = output.data as Float32Array
  const boxes: Box[] = []
  const threshold = crop.target ? 0.1 : crop.queueDetail ? 0.14 : 0.17
  let index = 0
  try {
    for (const stride of [8, 16, 32]) {
      const side = size / stride
      for (let cy = 0; cy < side; cy++)
        for (let cx = 0; cx < side; cx++, index += 85) {
          const objectness = values[index + 4]
          if (objectness < threshold) continue
          let kind = 0
          for (let k = 1; k < 80; k++)
            if (values[index + 5 + k] > values[index + 5 + kind]) kind = k
          const score = objectness * values[index + 5 + kind]
          if (!(kind in vehicleNames) || score < threshold) continue
          const x = ((values[index] + cx) * stride) / scale,
            y = ((values[index + 1] + cy) * stride) / scale
          if (
            x < 0 ||
            x > (rear ? size : crop.w) ||
            y < 0 ||
            y > (rear ? size : crop.h)
          )
            continue
          const w = (Math.exp(values[index + 2]) * stride) / scale,
            h = (Math.exp(values[index + 3]) * stride) / scale
          const source = rear
            ? rear.box(x, y, w, h)
            : { cx: crop.x + x, cy: crop.y + y, w, h }
          const left = Math.max(0, source.cx - source.w / 2) / frame.width,
            top = Math.max(0, source.cy - source.h / 2) / frame.height
          const right =
              Math.min(frame.width, source.cx + source.w / 2) / frame.width,
            bottom =
              Math.min(frame.height, source.cy + source.h / 2) / frame.height
          if (right > left && bottom > top) {
            const box = {
              x: left,
              y: top,
              w: right - left,
              h: bottom - top,
              kind,
              score,
            }
            if (!crop.target || score >= 0.17 || sameVehicle(box, crop.target))
              boxes.push(box)
          }
        }
    }
    return boxes
  } finally {
    tensor.dispose()
    output.dispose()
  }
}

function suppressDuplicates(boxes: Box[]) {
  const kept: Box[] = []
  for (const box of boxes.sort((a, b) => b.score - a.score))
    if (kept.every((other) => !sameVehicle(other, box))) kept.push(box)
  return kept
}

function targetBounds(
  b: Rect,
  aspect: number,
): [number, number, number, number] {
  const width = Math.min(0.72, Math.max(0.17, 3.5 * b.w, (3.5 * b.h) / aspect))
  const height = Math.min(1, width * aspect)
  const left = Math.max(0, Math.min(1 - width, b.x + b.w / 2 - width / 2))
  const top = Math.max(0, Math.min(1 - height, b.y + b.h / 2 - height / 2))
  return [left, top, left + width, top + height]
}

let nextGroup = 0
let targetFirst = false

async function analyze(session: InferenceSession, frame: Frame) {
  const started = performance.now()
  const view = signature(frame)
  const rear = frame.rearApproach
  const readable = frame.lanes.map((lane) => laneReadable(frame, lane))
  const rearReadable =
    frame.rearApproach && laneReadable(frame, frame.rearApproach)
  const fullFrame = view.visible
    ? await detect(session, frame, {
        x: 0,
        y: 0,
        w: frame.width,
        h: frame.height,
      })
    : []
  // 전체 화면의 차량 후보는 원본에서 구하고, 확대 검사에서는 자막 획을 제거합니다.
  const landmark = prepareLandmarks(frame.camera, frame)
  const isPaint = roadMarkingFilter(frame.camera, frame)
  const fixedObject = (box: Box, rawCaption = false) =>
    landmark(box, rawCaption) || isPaint(box)
  const daylightRear =
    !!rear &&
    frame.camera === 'gits-6581' &&
    frame.width >= 320 &&
    Math.abs(frame.width / frame.height - 1.5) < 0.04 &&
    view.visible &&
    view.signature.slice(11, 19).sort()[3] >= 65
  function spansQueue(b: Box) {
    // 후방 도로의 여러 차로에 걸쳐 길게 생기는 단일 차량 상자를 거릅니다.
    if (!daylightRear || !rear || b.h < 0.22) return false
    const y = b.y + b.h / 2
    return (
      b.h * 480 > 50 + Math.max(0, (y * 480 - 96) * 0.72) &&
      [0.25, 0.5, 0.75].some((f) => inLane(b.x + f * b.w, y, rear))
    )
  }
  const vehicleIn = (b: Box, lanes: Lane[]) =>
    lanes.some((lane) => inLane(b.x + b.w / 2, b.y + b.h * 0.94, lane))
  const withinProfile = (b: Box) => {
    if (!frame.detailRegions || vehicleIn(b, frame.lanes)) return true
    if (
      !frame.trackingAreas ||
      !(
        vehicleIn(b, frame.trackingAreas) ||
        frame.trackedBoxes?.some((track) => sameVehicle(track, b))
      )
    )
      return false
    b.inTransit = true
    return true
  }
  const boxes = fullFrame.filter(
    (b) => withinProfile(b) && !fixedObject(b, true) && !spansQueue(b),
  )
  self.postMessage({
    type: 'coarse',
    ...view,
    readable,
    rearReadable,
    boxes: suppressDuplicates(boxes),
  })
  // 같은 접근로의 인접 차로를 묶어 작은 차량을 원본보다 크게 다시 확인합니다.
  const groups: Lane[][] = []
  const byDirection = new Map<string, Lane[]>()
  for (const [i, lane] of frame.lanes.entries()) {
    const direction = frame.directions?.[i]
    const adjacent = direction
      ? byDirection.get(direction)
      : groups.find((group) =>
          group.some(
            (other) =>
              other[1][0] === lane[0][0] &&
              other[1][1] === lane[0][1] &&
              other[2][0] === lane[3][0] &&
              other[2][1] === lane[3][1],
          ),
        )
    if (adjacent) adjacent.push(lane)
    else {
      const group = [lane]
      groups.push(group)
      if (direction) byDirection.set(direction, group)
    }
  }
  if (rear) groups.push([rear])
  const regions = frame.detailRegions
  const count = regions?.length ?? Math.min(groups.length, 3)
  // 후방과 정지선 검사를 교대로 실행합니다. 느린 기기에서도 중단한 순서부터 이어갑니다.
  const order =
    daylightRear && count === 3
      ? [2, 0, 2, 1]
      : Array.from({ length: count }, (_, i) => i)
  let rearScanned = false
  const targetPass = targetFirst ? 0 : 1
  if (frame.movingTarget) targetFirst = !targetFirst
  const scans = rear || regions ? Math.min(2, count) : count
  for (let n = 0; view.visible && n < scans; n++) {
    const turn = nextGroup % order.length
    const index = order[turn]
    if ((n > 0 || !frame.trackedBoxes) && performance.now() - started > 420) {
      nextGroup = turn
      break
    }
    // 고정 차로와 추적 차량의 우선순위를 번갈아 두어 한 번만 확대할 수 있는 기기에서도 양쪽을 검사합니다.
    const target = n === targetPass ? frame.movingTarget : undefined
    if (!target) nextGroup = (turn + 1) % order.length
    const region = regions?.[index]
    const group = region
      ? region.lanes.map((i) => frame.lanes[i])
      : groups[index]
    const points = region ? [] : group.flat(),
      xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1])
    const rearScan = !!rear && !target && group[0] === rear
    // 화면 위쪽 논밭의 밝기로 주야간을 구분해 전조등의 영향을 줄입니다.
    const detail = rearScan && !!daylightRear
    const [left, top, right, bottom] = (target &&
      targetBounds(target, frame.width / frame.height)) ??
      region?.bounds ?? [
        Math.max(0, Math.min(...xs) - (rearScan && !detail ? 0.18 : 0.055)),
        Math.max(0, Math.min(...ys) - (rearScan ? 0.2 : 0.13)),
        Math.min(1, Math.max(...xs) + (rearScan && !detail ? 0.15 : 0.055)),
        Math.min(1, Math.max(...ys) + (rearScan ? 0.09 : 0.04)),
      ]
    if ((right - left) * (bottom - top) < 0.7) {
      const zoomed = await detect(session, frame, {
        x: left * frame.width,
        y: top * frame.height,
        w: (right - left) * frame.width,
        h: (bottom - top) * frame.height,
        queueDetail: detail,
        target,
        brighten:
          !!target ||
          (!detail &&
            view.signature.reduce((sum, pixel) => sum + pixel, 0) /
              view.signature.length <
              110),
      })
      if (rearScan) rearScanned = true
      if (detail) {
        for (const b of zoomed) b.queueCandidate = true
      }
      // 잘린 물체가 전체 화면에서 검출된 차량과 중복되지 않게 합니다.
      boxes.push(
        ...zoomed.filter(
          (b) =>
            (target || region?.includeTransit
              ? withinProfile(b)
              : !region || vehicleIn(b, group)) &&
            (!rearScan || inLane(b.x + b.w / 2, b.y + b.h * 0.94, rear)) &&
            b.x > left + 0.003 &&
            b.x + b.w < right - 0.003 &&
            (top === 0 || b.y > top + 0.003) &&
            b.y + b.h < bottom - 0.003,
        ),
      )
    }
  }
  return {
    ...view,
    boxes: suppressDuplicates(
      boxes.filter((b) => !fixedObject(b) && !spansQueue(b)),
    ),
    rearScanned,
    readable,
    rearReadable,
  }
}

let session: InferenceSession
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const read = async (path: string) => {
        const response = await fetch(new URL(path, self.location.origin))
        if (!response.ok) throw new Error('asset unavailable')
        return new Uint8Array(await response.arrayBuffer())
      }
      const [wasm, model] = await Promise.all([read(wasmPath), read(modelPath)])
      env.wasm.wasmBinary = wasm
      try {
        session = await InferenceSession.create(model, {
          executionProviders: ['wasm'],
        })
      } finally {
        env.wasm.wasmBinary = undefined
      }
      self.postMessage({ type: 'ready' })
    } else {
      self.postMessage({ type: 'frame', ...(await analyze(session, data)) })
    }
  } catch {
    self.postMessage({ type: 'error' })
  }
}
