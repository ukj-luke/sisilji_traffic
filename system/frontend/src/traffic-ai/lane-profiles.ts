import registry from './camera-lanes.json' with { type: 'json' }
import type { Lane, LaneLabel, Quad } from './metrics'

export type DetailRegion = {
  bounds: [number, number, number, number]
  includeTransit?: boolean
  lanes: number[]
}

export type LaneProfile = {
  trackVehicles?: boolean
  lanes: Lane[]
  labels?: LaneLabel[]
  rearApproach?: Lane
  trackingAreas?: Lane[]
  detailRegions?: DetailRegion[]
  widthReferences?: Record<number, number>
  rearDirection?: string
  observationNote?: string
  minMedian?: number
}

const registered = registry as unknown as Record<string, LaneProfile>
const empty: LaneProfile = { lanes: [] }
export function registeredLanes(camera: string): LaneProfile {
  return registered[camera] ?? empty
}

export function validManualLane(value: unknown): value is Quad {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => Number.isFinite(n) && n >= 0 && n <= 1),
    )
  )
    return false
  const points = value as Quad
  const turns = points.map(([x, y], i) => {
    const [u, v] = points[(i + 1) % 4],
      [m, n] = points[(i + 2) % 4]
    return (u - x) * (n - v) - (v - y) * (m - u)
  })
  const area =
    Math.abs(
      points.reduce(
        (a, [x, y], i) =>
          a + x * points[(i + 1) % 4][1] - y * points[(i + 1) % 4][0],
        0,
      ),
    ) / 2
  return (
    area >= 0.002 && (turns.every((t) => t > 0) || turns.every((t) => t < 0))
  )
}

const storageKey = (camera: string) => 'sisilji.manual-lanes.v1.' + camera
export function loadManualLanes(camera: string): LaneProfile | null {
  try {
    const raw = localStorage.getItem(storageKey(camera))
    if (!raw) return null
    const lanes: unknown = JSON.parse(raw)
    return Array.isArray(lanes) && lanes.length && lanes.every(validManualLane)
      ? { lanes }
      : null
  } catch {
    return null
  }
}

export function saveManualLanes(camera: string, profile: LaneProfile | null) {
  try {
    if (profile)
      localStorage.setItem(storageKey(camera), JSON.stringify(profile.lanes))
    else localStorage.removeItem(storageKey(camera))
    return true
  } catch {
    return false
  }
}
