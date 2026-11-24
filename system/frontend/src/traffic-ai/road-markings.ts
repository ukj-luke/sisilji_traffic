import patches from './mulwang-road-paint.json' with { type: 'json' }
import wolgot from './wolgot-road-paint.json' with { type: 'json' }
import police from './police-road-paint.json' with { type: 'json' }
import policeNight from './police-night-road-patterns.json' with { type: 'json' }
import policeSignal from './police-signal-patterns.json' with { type: 'json' }
import type { Box } from './metrics'

type Frame = { width: number; height: number; pixels: Uint8ClampedArray }
// 작은 도색의 압축 잡음과 1픽셀 경계 차이를 줄이기 위해 기준·현재 영상에 같은 필터를 적용합니다.
function smooth(pixels: Uint8Array, width: number) {
  const rows = new Uint16Array(pixels.length)
  const output = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    const col = i % width
    rows[i] =
      pixels[col ? i - 1 : i] +
      2 * pixels[i] +
      pixels[col + 1 < width ? i + 1 : i]
  }
  for (let i = 0; i < pixels.length; i++) {
    const above = i < width ? i : i - width,
      below = i + width < pixels.length ? i + width : i
    output[i] = (rows[above] + 2 * rows[i] + rows[below] + 8) >> 4
  }
  return output
}

const references = (entries: typeof patches) =>
  entries.map(({ core: [x, y, w, h], padding, gray }) => ({
    x,
    y,
    w,
    h,
    padding,
    stride: w + 2 * padding,
    gray: smooth(
      Uint8Array.from(atob(gray), (c) => c.charCodeAt(0)),
      w + 2 * padding,
    ),
  }))
const byCamera: Record<string, ReturnType<typeof references>> = {
  'gits-6581': references(patches),
  'gits-6578': references(wolgot),
  'gits-6590': references([...police, ...policeNight, ...policeSignal]),
}
type Reference = ReturnType<typeof references>[number]
const radius = 2

function readPatch(frame: Frame, ref: Reference) {
  const width = ref.stride + 2 * radius,
    height = ref.h + 2 * (ref.padding + radius)
  const gray = new Uint8Array(width * height)
  for (let j = 0; j < height; j++) {
    const y = Math.floor(
      ((ref.y - ref.padding - radius + j + 0.5) * frame.height) / 480,
    )
    for (let i = 0; i < width; i++) {
      const x = Math.floor(
        ((ref.x - ref.padding - radius + i + 0.5) * frame.width) / 720,
      )
      const k = 4 * (y * frame.width + x)
      gray[j * width + i] =
        (77 * frame.pixels[k] +
          150 * frame.pixels[k + 1] +
          29 * frame.pixels[k + 2]) >>
        8
    }
  }
  return smooth(gray, width)
}

type Bounds = { left: number; top: number; right: number; bottom: number }

function samePaint(
  ref: Reference,
  current: Uint8Array,
  box: Bounds,
  dx: number,
  dy: number,
) {
  const stride = ref.stride + 2 * radius,
    pad = ref.padding
  const x0 = ref.x - pad + dx,
    y0 = ref.y - pad + dy
  const left = Math.floor(box.left - x0),
    right = Math.ceil(box.right - x0)
  const top = Math.floor(box.top - y0),
    bottom = Math.ceil(box.bottom - y0)
  if (left < 0 || top < 0 || right > ref.stride || bottom > ref.h + 2 * pad)
    return false
  const offset = (radius + dy) * stride + radius + dx
  // 도색과 테두리에서 밝기·대비 차이를 보정하고 실제 윤곽이 일치하는지 확인합니다.
  let sumRef = 0,
    sumLive = 0,
    squaresRef = 0,
    squaresLive = 0,
    cross = 0
  const n = (ref.w + 2) * (ref.h + 2)
  for (let y = pad - 1; y <= pad + ref.h; y++) {
    for (let x = pad - 1; x <= pad + ref.w; x++) {
      const original = ref.gray[y * ref.stride + x],
        live = current[offset + y * stride + x]
      sumRef += original
      sumLive += live
      squaresRef += original * original
      squaresLive += live * live
      cross += original * live
    }
  }
  const energyRef = squaresRef - (sumRef * sumRef) / n,
    energyLive = squaresLive - (sumLive * sumLive) / n
  const covariance = cross - (sumRef * sumLive) / n
  if (
    energyRef < n * 16 ||
    energyLive < n * 16 ||
    covariance <= 0 ||
    covariance * covariance < 0.8 ** 2 * energyRef * energyLive
  )
    return false
  const gain = covariance / energyRef,
    bias = (sumLive - gain * sumRef) / n
  if (gain < 0.35 || gain > 2.8) return false
  // 상자 안의 노면까지 확인해 도색 일부만 보이는 실제 차량은 유지합니다.
  const deviation = Math.sqrt(energyLive / n)
  const limit = Math.max(12, 0.8 * deviation + 4),
    area = (right - left) * (bottom - top)
  let changed = 0,
    totalError = 0
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const expected = ref.gray[y * ref.stride + x] * gain + bias
      const error = Math.abs(current[offset + y * stride + x] - expected)
      totalError += error
      if (error > limit) {
        changed++
        if (changed > area * 0.13) return false
      }
    }
  }
  return totalError < area * Math.max(8, deviation * 0.58)
}

export function roadMarkingFilter(camera: string, frame: Frame) {
  const refs = byCamera[camera]
  if (
    !refs ||
    frame.width < 320 ||
    Math.abs(frame.width / frame.height - 1.5) > 0.04
  )
    return () => false
  const samples = new Map<Reference, Uint8Array>()
  return (b: Box) => {
    const left = b.x * 720,
      top = b.y * 480,
      w = b.w * 720,
      h = b.h * 480
    const cx = left + w / 2,
      cy = top + h / 2
    for (const ref of refs) {
      if (
        w <= 0 ||
        h <= 0 ||
        w > ref.stride ||
        h > ref.h + 2 * ref.padding ||
        Math.abs(cx - ref.x - ref.w / 2) > ref.w * 0.55 + radius ||
        Math.abs(cy - ref.y - ref.h / 2) > ref.h * 0.55 + radius
      )
        continue
      let patch = samples.get(ref)
      if (!patch) {
        patch = readPatch(frame, ref)
        samples.set(ref, patch)
      }
      const bounds = { left, top, right: left + w, bottom: top + h }
      if (samePaint(ref, patch, bounds, 0, 0)) return true
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if ((dx || dy) && samePaint(ref, patch, bounds, dx, dy)) return true
        }
    }
    return false
  }
}
