// 물왕교차로 720×480 기준. 원근에 따라 먼 행을 더 확대하되 차량의 가로·세로 배율은 맞춥니다.
export class RearView {
  private readonly top: number
  private readonly center: number
  private readonly farScale: number
  private readonly slope: number

  private readonly width: number
  private readonly height: number
  private readonly size: number

  constructor(width: number, height: number, size: number) {
    this.width = width
    this.height = height
    this.size = size
    this.top = (77 * height) / 480
    this.center = (230 * width) / 720
    const span = ((249 - 77) * height) / 480
    const nearScale = (size - 8) / ((span * (1.75 + 1)) / 2)
    this.farScale = 1.75 * nearScale
    this.slope = (nearScale - this.farScale) / span
  }

  private sourceY(v: number) {
    const distance = v - 4
    return (
      this.top +
      (2 * distance) /
        (this.farScale +
          Math.sqrt(
            Math.max(0, this.farScale ** 2 + 2 * this.slope * distance),
          ))
    )
  }

  private scale(y: number) {
    return this.farScale + this.slope * (y - this.top)
  }

  private centerX(y: number) {
    return (
      this.center +
      0.22 *
        (this.width / 720) *
        (480 / this.height) *
        (y - (168 * this.height) / 480)
    )
  }

  box(u: number, v: number, w: number, h: number) {
    const y = this.sourceY(v),
      k = this.scale(y)
    return {
      cx: this.centerX(y) + (u - this.size / 2) / k,
      cy: y,
      w: w / k,
      h:
        this.sourceY(Math.min(this.size, v + h / 2)) -
        this.sourceY(Math.max(0, v - h / 2)),
    }
  }

  write(pixels: Uint8ClampedArray, input: Float32Array) {
    const plane = this.size * this.size
    for (let v = 0; v < this.size; v++) {
      const y = this.sourceY(v),
        step = 1 / this.scale(y)
      const firstX = this.centerX(y) - (this.size / 2) * step
      const iy = Math.max(0, Math.min(this.height - 2, Math.floor(y))),
        dy = y - iy
      for (let u = 0; u < this.size; u++) {
        const x = firstX + u * step
        const ix = Math.max(0, Math.min(this.width - 2, Math.floor(x))),
          dx = x - ix
        const top = (iy * this.width + ix) * 4,
          bottom = top + this.width * 4
        for (let c = 0; c < 3; c++) {
          const a =
            pixels[top + c] + dx * (pixels[top + 4 + c] - pixels[top + c])
          const b =
            pixels[bottom + c] +
            dx * (pixels[bottom + 4 + c] - pixels[bottom + c])
          input[(2 - c) * plane + v * this.size + u] = a + dy * (b - a)
        }
      }
    }
  }
}
