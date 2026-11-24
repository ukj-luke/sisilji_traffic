import calibration from './mulwang-landmarks.json' with { type: 'json' }
import daylight from './mulwang-day-fixtures.json' with { type: 'json' }
import police from './police-landmarks.json' with { type: 'json' }
import type { Box } from './metrics'

type Frame = { width: number; height: number; pixels: Uint8ClampedArray }
type Rect = { x: number; y: number; w: number; h: number }
type Edge = {
  light: number
  dark: number
  contrast: number
  x: number
  y: number
}
type Fill = { pixel: number; first: number; last: number; weight: number }
type Landmark = {
  panel?: Panel
  rect: Rect
  core?: Rect
  edges: Edge[]
  fills: Fill[]
}
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const referenceWidth = 720,
  referenceHeight = 480

// 자막의 획과 테두리만 양옆 또는 위아래의 보이는 영상으로 메웁니다.
function makeFills(
  rect: Rect,
  strokes: string,
  sourceW: number,
  sourceH: number,
  width: number,
) {
  const bits = decode(strokes)
  const ink = (x: number, y: number) => {
    if (x < 0 || x >= rect.w || y < 0 || y >= rect.h) return false
    const pos =
      Math.floor((y * sourceH) / rect.h) * sourceW +
      Math.floor((x * sourceW) / rect.w)
    return !!(bits[pos >> 3] & (128 >> pos % 8))
  }
  const fills: Fill[] = []
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      if (!ink(x, y)) continue
      let left = 1,
        right = 1,
        up = 1,
        down = 1
      while (ink(x - left, y)) left++
      while (ink(x + right, y)) right++
      while (ink(x, y - up)) up++
      while (ink(x, y + down)) down++
      const horizontal = left + right < up + down
      const step = horizontal ? 1 : width
      const a = horizontal ? left : up,
        b = horizontal ? right : down
      const pixel = (rect.y + y) * width + rect.x + x
      fills.push({
        pixel: pixel * 4,
        first: (pixel - a * step) * 4,
        last: (pixel + b * step) * 4,
        weight: a / (a + b),
      })
    }
  return fills
}

type Entry = {
  name: string
  rect: number[]
  core?: number[]
  edges: string
  strokes?: string
}
const byCamera: Record<string, Entry[]> = {
  'gits-6581': [...calibration, ...daylight],
  'gits-6590': police,
}
export function signOccluder(camera: string): Rect | undefined {
  const entry = byCamera[camera]?.find((e) => e.name === 'policeOverheadSign')
  if (!entry?.core) return
  const [x, y, w, h] = entry.core
  return {
    x: x / referenceWidth,
    y: y / referenceHeight,
    w: w / referenceWidth,
    h: h / referenceHeight,
  }
}
let layout:
  | { camera: string; width: number; height: number; landmarks: Landmark[] }
  | undefined
function getLayout(camera: string, width: number, height: number) {
  if (
    layout?.camera === camera &&
    layout.width === width &&
    layout.height === height
  )
    return layout.landmarks
  const sx = width / referenceWidth,
    sy = height / referenceHeight
  const landmarks = byCamera[camera].map((entry) => {
    const [x, y, w, h] = entry.rect
    const rect = {
      x: Math.round(x * sx),
      y: Math.round(y * sy),
      w: Math.max(1, Math.round(w * sx)),
      h: Math.max(1, Math.round(h * sy)),
    }
    const pairs = decode(entry.edges),
      edges: Edge[] = []
    const pixel = (a: number, b: number) =>
      (Math.round((y + b) * sy) * width + Math.round((x + a) * sx)) * 4
    for (let i = 0; i < pairs.length; i += 5)
      edges.push({
        light: pixel(pairs[i], pairs[i + 1]),
        dark: pixel(pairs[i + 2], pairs[i + 3]),
        contrast: pairs[i + 4],
        x: (x + (pairs[i] + pairs[i + 2]) / 2) * sx,
        y: (y + (pairs[i + 1] + pairs[i + 3]) / 2) * sy,
      })
    return {
      rect,
      panel: panels[entry.name],
      core: entry.core
        ? {
            x: entry.core[0] * sx,
            y: entry.core[1] * sy,
            w: entry.core[2] * sx,
            h: entry.core[3] * sy,
          }
        : undefined,
      edges,
      fills:
        'strokes' in entry && entry.strokes
          ? makeFills(rect, entry.strokes, w, h, width)
          : [],
    }
  })
  layout = { camera, width, height, landmarks }
  return landmarks
}

function luminance(pixels: Uint8ClampedArray, k: number) {
  return (77 * pixels[k] + 150 * pixels[k + 1] + 29 * pixels[k + 2]) / 256
}
function contains(r: Rect, x: number, y: number) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

type Panel = {
  xs: number[]
  x: number
  y: number
  slope: number
  inside: number
  above: number
  below: number
}
const panels: Record<string, Panel> = {
  dayOverheadSign: {
    xs: [255, 264, 275, 286, 297],
    x: 252,
    y: 265,
    slope: 0.102,
    inside: 4,
    above: 15,
    below: 14,
  },
  policeOverheadSign: {
    xs: [210, 226, 247, 270, 285],
    x: 210,
    y: 240,
    slope: 0.105,
    inside: 9,
    above: 22,
    below: 22,
  },
}

function hasBlueSignFace(frame: Frame, panel: Panel) {
  function blue(x: number, y: number) {
    const k =
      (Math.round((y * frame.height) / referenceHeight) * frame.width +
        Math.round((x * frame.width) / referenceWidth)) *
      4
    const r = frame.pixels[k],
      g = frame.pixels[k + 1],
      b = frame.pixels[k + 2]
    return b - r > 48 && b - g > 30 && g - r > 10
  }
  let columns = 0
  for (const x of panel.xs) {
    const y = panel.y - Math.round((x - panel.x) * panel.slope)
    if (
      blue(x, y - panel.inside) &&
      blue(x, y + panel.inside) &&
      !blue(x, y - panel.above) &&
      !blue(x, y + panel.below)
    )
      columns++
  }
  return columns >= 4
}

export function prepareLandmarks(
  camera: string,
  frame: Frame,
): (box: Box, rawCaption?: boolean) => boolean {
  const { width, height, pixels } = frame
  if (
    !byCamera[camera] ||
    width < 320 ||
    Math.abs(width / height - referenceWidth / referenceHeight) > 0.04
  )
    return () => false
  const verified: {
    rect: Rect
    core?: Rect
    edges: Edge[]
    policePanel: boolean
    blueFace: boolean
    caption: boolean
    matched: boolean[]
  }[] = []
  for (const { rect, core, edges, fills, panel } of getLayout(
    camera,
    width,
    height,
  )) {
    const matched = edges.map(
      (e) =>
        luminance(pixels, e.light) - luminance(pixels, e.dark) >= e.contrast,
    )
    const ratio = matched.filter(Boolean).length / edges.length
    const verifiedBlue = !!panel && hasBlueSignFace(frame, panel)
    if (!verifiedBlue && ratio < (fills.length ? 0.82 : 0.76)) continue
    if (fills.length) {
      for (const { pixel, first, last, weight } of fills) {
        for (let k = 0; k < 3; k++)
          pixels[pixel + k] =
            pixels[first + k] * (1 - weight) + pixels[last + k] * weight
      }
    }
    verified.push({
      rect,
      core,
      edges,
      matched,
      policePanel: panel === panels.policeOverheadSign,
      blueFace: verifiedBlue,
      caption: fills.length > 0,
    })
  }

  function excludes(box: Box, rawCaption = false) {
    const b = {
      x: box.x * width,
      y: box.y * height,
      w: box.w * width,
      h: box.h * height,
    }
    return verified.some(
      ({ rect, core, edges, matched, caption, blueFace, policePanel }) => {
        if (caption && !rawCaption) return false
        if (!contains(rect, b.x + b.w / 2, b.y + b.h / 2)) return false
        if (policePanel && core) {
          // 세 차로 위 파란 판면의 양 끝과 위·아래 경계가 보이는지 확인합니다.
          // 판면보다 좁은 상자나 차체가 아래로 길게 이어지는 상자는 유지합니다.
          const cx = b.x + b.w / 2,
            cy = core.y + core.h * 0.5
          const spansPanel =
            Math.abs(cx - (core.x + core.w / 2)) < core.w * 0.22 &&
            b.w >= core.w * 0.84 &&
            b.w <= core.w * 1.45 &&
            b.h <= core.h * 2.55 &&
            b.y >= core.y - core.h * 0.9 &&
            b.y + b.h <= core.y + core.h * 2.3 &&
            contains(b, core.x + core.w * 0.1, cy) &&
            contains(b, core.x + core.w * 0.9, cy) &&
            contains(b, core.x + core.w * 0.5, core.y + core.h * 0.12) &&
            contains(b, core.x + core.w * 0.5, core.y + core.h * 0.88)
          if (!spansPanel) return false
          if (blueFace) return true
        }
        if (
          blueFace &&
          core &&
          (b.y < rect.y - (6 * height) / referenceHeight ||
            b.y + b.h > core.y + core.h + (16 * height) / referenceHeight)
        )
          return false
        if (core) {
          const shared =
            Math.max(
              0,
              Math.min(core.x + core.w, b.x + b.w) - Math.max(core.x, b.x),
            ) *
            Math.max(
              0,
              Math.min(core.y + core.h, b.y + b.h) - Math.max(core.y, b.y),
            )
          if (shared < 0.55 * Math.min(core.w * core.h, b.w * b.h)) return false
        }
        const margin = (2 * width) / referenceWidth
        const iw = Math.max(
          0,
          Math.min(rect.x + rect.w + margin, b.x + b.w) -
            Math.max(rect.x - margin, b.x),
        )
        const ih = Math.max(
          0,
          Math.min(rect.y + rect.h + margin, b.y + b.h) -
            Math.max(rect.y - margin, b.y),
        )
        if (iw * ih < b.w * b.h * 0.78) return false
        if (
          blueFace &&
          core &&
          b.w >= core.w * 0.72 &&
          contains(b, core.x + core.w * 0.2, core.y + core.h * 0.5) &&
          contains(b, core.x + core.w * 0.8, core.y + core.h * 0.5)
        )
          return true
        let total = 0,
          agree = 0
        edges.forEach((edge, i) => {
          if (contains(b, edge.x, edge.y)) {
            total++
            if (matched[i]) agree++
          }
        })
        return total >= 5 && agree / total >= 0.78
      },
    )
  }
  return excludes
}
