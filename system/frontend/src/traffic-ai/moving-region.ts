import type { GrayFrame } from './follow'
import type { Rect } from './metrics'

// 서로 다른 두 과거 프레임과 비교해 방금 움직인 부분을 찾습니다.
// 여기서 찾은 영역은 검출기의 확대 입력으로만 사용합니다.
export function movingRegions(
  now: GrayFrame,
  recent: GrayFrame,
  earlier: GrayFrame,
): Rect[] {
  const { width, height, pixels } = now
  const step = 3,
    cols = Math.floor(width / step),
    rows = Math.floor(height / step)
  const active = new Uint8Array(cols * rows)
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1; x < cols - 1; x++) {
      const i = (y * width + x) * step
      const a = pixels[i] - recent.pixels[i],
        b = pixels[i] - earlier.pixels[i]
      if (Math.abs(a) > 13 && Math.abs(b) > 13 && a * b > 0)
        active[y * cols + x] = 1
    }
  const stack = new Int32Array(active.length)
  const neighbors = [
    -cols - 1,
    -cols,
    -cols + 1,
    -1,
    1,
    cols - 1,
    cols,
    cols + 1,
  ]
  const result: Rect[] = []
  for (let i = cols; i < active.length - cols; i++) {
    if (!active[i]) continue
    let head = 0,
      tail = 1,
      left = cols,
      right = 0,
      top = rows,
      bottom = 0
    active[i] = 0
    stack[0] = i
    while (head < tail) {
      const at = stack[head++],
        y = Math.floor(at / cols),
        x = at - y * cols
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      for (const offset of neighbors) {
        const next = at + offset
        if (active[next]) {
          active[next] = 0
          stack[tail++] = next
        }
      }
    }
    const w = right - left + 1,
      h = bottom - top + 1
    if (
      tail < 5 ||
      tail < w * h * 0.15 ||
      w < 2 ||
      h < 2 ||
      w * step > width * 0.24 ||
      h * step > height * 0.32
    )
      continue
    result.push({
      x: ((left - 0.5) * step) / width,
      y: ((top - 0.5) * step) / height,
      w: (w * step) / width,
      h: (h * step) / height,
    })
  }
  return result.sort((a, b) => b.w * b.h - a.w * a.h)
}
