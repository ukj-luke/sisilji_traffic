import type { Box, Lane, Rect } from './metrics'

import type { DetailRegion } from './lane-profiles'

export type DetectorInput = {
  camera: string
  pixels: Uint8ClampedArray
  width: number
  height: number
  rearApproach?: Lane
  directions?: string[]
  trackingAreas?: Lane[]
  trackedBoxes?: Rect[]
  movingTarget?: Rect
  detailRegions?: DetailRegion[]
  lanes: Lane[]
}
export type Detection = {
  type: 'frame' | 'coarse'
  boxes: Box[]
  signature: Uint8Array
  visible: boolean
  rearScanned?: boolean
  rearReadable?: boolean
  readable: boolean[]
}
type Request = {
  partial: (data: Detection) => void
  resolve: (data: Detection) => void
  reject: (reason: Error) => void
}

let cached: Detector | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
let users = 0
function scheduleExpiry() {
  clearTimeout(expiry)
  if (!users) expiry = setTimeout(() => cached?.close(), 60000)
}

class Detector {
  readonly ready: Promise<void>
  private worker: Worker
  private request?: Request
  get busy() {
    return !!this.request
  }

  constructor() {
    this.worker = new Worker(new URL('./vehicle.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.ready = new Promise<void>((resolve, reject) => {
      const fail = () => {
        const error = new Error('detector unavailable')
        reject(error)
        this.request?.reject(error)
        this.close()
      }
      this.worker.onerror = fail
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'error') {
          fail()
          return
        }
        if (data.type === 'ready') {
          resolve()
          return
        }
        if (data.type === 'coarse') {
          this.request?.partial(data)
          return
        }
        if (data.type === 'frame') {
          const request = this.request
          this.request = undefined
          request?.resolve(data)
        }
      }
      this.worker.postMessage({ type: 'init' })
    })
  }
  run(input: DetectorInput, partial: Request['partial']) {
    return new Promise<Detection>((resolve, reject) => {
      this.request = { partial, resolve, reject }
      try {
        this.worker.postMessage({ type: 'frame', ...input }, [
          input.pixels.buffer,
        ])
      } catch (error) {
        this.request = undefined
        reject(error)
      }
    })
  }
  close() {
    this.worker.terminate()
    this.request?.reject(new Error('detector closed'))
    this.request = undefined
    if (cached === this) cached = undefined
  }
}

export function warmDetector() {
  try {
    cached ??= new Detector()
    void cached.ready.catch(() => {})
    scheduleExpiry()
  } catch {
    /* 토글을 켜면 오류 안내와 재시도를 제공합니다. */
  }
}
export function acquireDetector() {
  cached ??= new Detector()
  const detector = cached
  users++
  clearTimeout(expiry)
  return {
    detector,
    release: () => {
      users--
      scheduleExpiry()
    },
  }
}
