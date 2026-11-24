import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  laneSections,
  measure,
  windowPercent,
} from '../src/traffic-ai/metrics.ts'

const profile = JSON.parse(
  readFileSync(new URL('../src/traffic-ai/camera-lanes.json', import.meta.url)),
)
const registry = JSON.parse(
  readFileSync(
    new URL('../../data/central_intersection_cameras.json', import.meta.url),
  ),
)
const left = [
  [0.1, 0.1],
  [0.5, 0.1],
  [0.5, 0.9],
  [0.1, 0.9],
]
const right = [
  [0.5, 0.1],
  [0.9, 0.1],
  [0.9, 0.9],
  [0.5, 0.9],
]
const box = (x, y) => ({
  x: x - 0.02,
  y: y - 0.047,
  w: 0.04,
  h: 0.05,
  score: 0.9,
  kind: 2,
})

test('a vehicle belongs to one lane, one occupied segment per position', () => {
  const result = measure(
    [left, right],
    [
      box(0.2, 0.3),
      box(0.22, 0.31),
      box(0.75, 0.45),
      box(0.98, 0.5),
      box(0.5, 0.8),
    ],
    1.5,
  )
  assert.deepEqual(result.assignments, [0, 0, 1, -1, 0])
  assert.deepEqual(result.counts, [3, 1])
  assert.deepEqual(result.occupancy, [2 / 6, 1 / 6])
})
test('media-time average waits for valid samples and restarts after poor visibility', () => {
  const readings = [
    { time: 0, occupancy: [0] },
    { time: 1, occupancy: [0.5] },
    { time: 3, occupancy: [1] },
  ]
  assert.equal(windowPercent(readings.slice(0, 2), 0), null)
  assert.equal(windowPercent(readings, 0), 58)
  assert.equal(
    windowPercent(
      [
        ...readings,
        { time: 4, occupancy: [null] },
        { time: 5, occupancy: [0] },
      ],
      0,
    ),
    null,
  )
})
test('every registered camera has a fixed set of valid lane polygons', () => {
  assert.deepEqual(
    Object.keys(profile).sort(),
    Object.keys(registry)
      .map((id) => 'gits-' + id)
      .sort(),
  )
  for (const { lanes } of Object.values(profile)) {
    for (const points of lanes.flatMap(laneSections)) {
      assert.equal(points.length, 4)
      assert.ok(points.flat().every((v) => v >= 0 && v <= 1))
      const turns = points.map(([x, y], i) => {
        const [a, b] = points[(i + 1) % 4],
          [c, d] = points[(i + 2) % 4]
        return (a - x) * (d - b) - (b - y) * (c - a)
      })
      assert.ok(turns.every((v) => v > 0) || turns.every((v) => v < 0))
    }
  }
})

test('congestion needs motion evidence in a densely occupied lane', async () => {
  const { LaneMotion, congestionGrade } = await import(
    '../src/traffic-ai/metrics.ts'
  )
  const tracker = new LaneMotion()
  let result
  for (let step = 0; step <= 5; step++) {
    result = tracker.update(
      [box(0.3, 0.3), box(0.65, 0.2 + step * 0.014)],
      [0, 1],
      step * 0.3,
      1,
      2,
    )
  }
  assert.deepEqual(result.observed, [1, 1])
  assert.deepEqual(result.slow, [1, 0])
  assert.equal(congestionGrade(70, true, 1, 0, 1), '보통')
  assert.equal(congestionGrade(70, true, 1, 1, 1), '높음')
  assert.equal(congestionGrade(70, true, 3, 1, 1), '흐름 확인 중')
  assert.equal(congestionGrade(null, false, 0, 0, 0), '시야 불량')
  assert.deepEqual(
    tracker.update([box(0.3, 0.3)], [0], 10, 1, 2).observed,
    [0, 0],
  )
})

test('delayed detections are aligned to displayed pixels and expire after cuts', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const follower = new FrameFollower()
  const width = 100,
    height = 60
  function frame(time, offset) {
    const pixels = new Uint8Array(width * height).fill(20)
    for (let y = 0; y < 14; y++)
      for (let x = 0; x < 18; x++)
        pixels[(y + 19) * width + x + 22 + offset] =
          45 + ((x * 47 + y * 23) % 181)
    return { time, width, height, pixels }
  }
  const original = {
    x: 0.22,
    y: 19 / height,
    w: 0.18,
    h: 14 / height,
    kind: 2,
    score: 0.8,
  }
  follower.push(frame(0, 0))
  follower.push(frame(0.08, 3))
  follower.push(frame(0.16, 6))
  assert.equal(follower.observe([original], 0, true).length, 1)
  assert.ok(Math.abs(follower.visible[0].x - 0.28) < 0.016)
  for (let i = 3; i <= 10; i++) follower.push(frame(i * 0.08, 6))
  assert.deepEqual(follower.visible, [])
  const cut = frame(0.89, 0)
  cut.pixels.fill(235)
  assert.equal(follower.push(cut), true)
  assert.deepEqual(follower.observe([original], 0.8, true), [])
})
test('a weak box needs a distinct matching observation of motion', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const follower = new FrameFollower()
  const base = { x: 0.32, y: 0.3, w: 0.2, h: 0.2, kind: 2, score: 0.21 }
  const frame = (time) => ({
    time,
    width: 100,
    height: 60,
    pixels: new Uint8Array(6000).fill(42),
  })
  follower.push(frame(0))
  follower.observe([base], 0, false)
  follower.observe([base], 0, true)
  assert.equal(follower.visible.length, 0)
  follower.push(frame(0.12))
  follower.observe([base], 0.12, true)
  assert.equal(follower.visible.length, 0)
  follower.push(frame(0.24))
  follower.observe([{ ...base, x: 0.35 }], 0.24, true)
  assert.equal(follower.visible.length, 1)
  follower.reset()
  assert.deepEqual(follower.visible, [])
})

test('Mulwang landmarks need local image evidence and preserve a larger overlapping vehicle', async () => {
  const { prepareLandmarks } = await import('../src/traffic-ai/landmarks.ts')
  const landmarks = JSON.parse(
    readFileSync(
      new URL('../src/traffic-ai/mulwang-landmarks.json', import.meta.url),
    ),
  )
  const width = 720,
    height = 480
  const pixels = new Uint8ClampedArray(width * height * 4).fill(128)
  const frame = { pixels, width, height }
  const sign = {
    x: 246 / width,
    y: 238 / height,
    w: 57 / width,
    h: 40 / height,
    kind: 5,
    score: 0.8,
  }
  const exact = landmarks.find((l) => l.name === 'overheadSign')
  const pairs = Buffer.from(exact.edges, 'base64')
  const pos = (x, y) => 4 * ((exact.rect[1] + y) * width + exact.rect[0] + x)
  // 같은 좌표에 물체가 있어도 표지판의 특징이 보이지 않으면 통과시킵니다.
  assert.equal(prepareLandmarks('gits-6581', frame)(sign), false)
  for (let round = 0; round < 10; round++)
    for (let n = 0; n < pairs.length; n += 5) {
      const light = pos(pairs[n], pairs[n + 1]),
        dark = pos(pairs[n + 2], pairs[n + 3])
      const gap = pairs[n + 4] + 2 - (pixels[light] - pixels[dark])
      if (gap > 0)
        for (let k = 0; k < 3; k++) {
          pixels[light + k] += Math.ceil(gap / 2)
          pixels[dark + k] -= Math.ceil(gap / 2)
        }
    }
  const ignore = prepareLandmarks('gits-6581', frame)
  assert.equal(ignore(sign), true)
  assert.equal(ignore({ ...sign, w: 110 / width, h: 80 / height }), false)
  assert.equal(prepareLandmarks('gits-6602', frame)(sign), false)
  // 정차한 차량이 표지판을 가린 경우를 같은 프레임으로 반복 확인합니다.
  pixels.fill(126)
  for (let i = 0; i < 3; i++)
    assert.equal(prepareLandmarks('gits-6581', frame)(sign), false)
})

test('caption cleanup requires the letters and retains the surface behind them', async () => {
  const { prepareLandmarks } = await import('../src/traffic-ai/landmarks.ts')
  const refs = JSON.parse(
    readFileSync(
      new URL('../src/traffic-ai/mulwang-landmarks.json', import.meta.url),
    ),
  )
  const entry = refs.find((l) => l.name === 'cityHallCaption')
  const width = 720,
    height = 480,
    frame = { width, height, pixels: new Uint8ClampedArray(width * height * 4) }
  const background = [70, 110, 148, 255]
  for (let i = 0; i < frame.pixels.length; i += 4)
    frame.pixels.set(background, i)
  const raw = frame.pixels.slice()
  prepareLandmarks('gits-6581', frame)
  assert.deepEqual(frame.pixels, raw)
  const pairs = Buffer.from(entry.edges, 'base64')
  for (let i = 0; i < pairs.length; i += 5) {
    const at =
      4 * ((entry.rect[1] + pairs[i + 1]) * width + entry.rect[0] + pairs[i])
    frame.pixels.set([250, 250, 250, 255], at)
  }
  assert.notDeepEqual(frame.pixels, raw)
  const withText = frame.pixels.slice()
  prepareLandmarks('gits-6578', frame)
  assert.deepEqual(frame.pixels, withText)
  const fixedObject = prepareLandmarks('gits-6581', frame)
  assert.deepEqual(frame.pixels, raw)
  const [x, y, w, h] = entry.rect
  const caption = {
    x: x / width,
    y: y / height,
    w: w / width,
    h: h / height,
    score: 0.9,
    kind: 2,
  }
  assert.equal(fixedObject(caption, true), true)
  assert.equal(fixedObject(caption), false)
  assert.equal(fixedObject({ ...caption, h: 0.2 }, true), false)
})

test('Mulwang assigns the four Mokgam and three City Hall lanes independently, including both bends', () => {
  const { lanes, labels } = profile['gits-6581']
  assert.deepEqual(
    labels.map((l) => l.direction),
    [
      '목감동',
      '목감동',
      '목감동',
      '목감동',
      '시흥시청',
      '시흥시청',
      '시흥시청',
    ],
  )
  assert.deepEqual(
    labels.map((l) => l.movement),
    [
      '우회전 전용',
      '직진 · 바깥쪽',
      '직진 · 안쪽',
      '좌회전 전용',
      '직진 · 안쪽',
      '직진 · 바깥쪽',
      '우회전 합류',
    ],
  )
  const locations = [
    [237, 445],
    [349, 420],
    [397, 420],
    [446, 416],
    [472, 380],
    [524, 380],
    [688, 390],
    [632, 431],
  ]
  const result = measure(
    lanes,
    locations.map(([x, y]) => box(x / 720, y / 480)),
    1.5,
  )
  assert.deepEqual(result.assignments, [0, 1, 2, 3, 4, 5, 6, -1])
  assert.deepEqual(result.counts, [1, 1, 1, 1, 1, 1, 1])
  for (const i of [0, 6]) {
    const sections = laneSections(lanes[i])
    assert.ok(sections.length > 1)
    for (const section of sections) {
      const x = section.reduce((n, p) => n + p[0], 0) / 4,
        y = section.reduce((n, p) => n + p[1], 0) / 4
      assert.equal(measure(lanes, [box(x, y)], 1.5).assignments[0], i)
    }
  }
})

test('Mulwang rear approach reaches the distant queue and excludes the median, sidewalk and front lanes', () => {
  const { rearApproach, lanes } = profile['gits-6581']
  const positions = [
    [194, 106],
    [209, 145],
    [250, 205],
    [207, 195],
    [165, 125],
    [252, 139],
    [350, 210],
    [242, 260],
    [349, 420],
  ]
  const rear = lanes.length
  const all = measure(
    [...lanes, rearApproach],
    positions.map(([x, y]) => box(x / 720, y / 480)),
    1.5,
  )
  assert.deepEqual(all.assignments, [rear, rear, rear, rear, -1, -1, -1, 0, 1])
  const boundary = measure(
    [...lanes, rearApproach],
    [box(275 / 720, 235 / 480)],
    1.5,
  )
  assert.equal(
    boundary.counts.reduce((sum, n) => sum + n, 0),
    1,
  )
  assert.equal(boundary.counts[rear], 0)
})

test('a stopped weak queue candidate requires three separate focused observations in a matched view', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const candidate = {
    ...box(0.3, 0.3),
    w: 0.08,
    h: 0.08,
    score: 0.2,
    queueCandidate: true,
  }
  const run = (rear) => {
    const tracker = new FrameFollower()
    const results = []
    for (const time of [0, 0.15, 0.3]) {
      tracker.push({
        time,
        width: 120,
        height: 80,
        pixels: new Uint8Array(120 * 80).fill(80),
      })
      tracker.observe([candidate], time, false, rear, false)
      results.push(tracker.observe([candidate], time, true, rear, true).length)
      tracker.observe([candidate], time, true, rear, true)
    }
    return results
  }
  assert.deepEqual(run(true), [0, 0, 1])
  assert.deepEqual(run(false), [0, 0, 0])
})

test('the daylight sign filter distinguishes the blue panel from an overlapping vehicle', async () => {
  const { prepareLandmarks } = await import('../src/traffic-ai/landmarks.ts')
  const width = 720,
    height = 480,
    pixels = new Uint8ClampedArray(width * height * 4).fill(140)
  function paint(x0, y0, x1, y1, color) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) pixels.set(color, 4 * (y * width + x))
  }
  const frame = { pixels, width, height }
  const sign = {
    x: 251 / width,
    y: 232 / height,
    w: 62 / width,
    h: 45 / height,
    kind: 5,
    score: 0.9,
  }
  for (let x = 252; x < 301; x++) {
    const y = 265 - Math.round((x - 252) * 0.102)
    paint(x, y - 7, x, y + 7, [47, 80, 145, 255])
  }
  const exclude = prepareLandmarks('gits-6581', frame)
  assert.equal(exclude(sign), true)
  assert.equal(exclude({ ...sign, y: 235 / height, h: 47 / height }), true)
  assert.equal(exclude({ ...sign, y: 220 / height, h: 65 / height }), false)
  assert.equal(exclude({ ...sign, h: 78 / height }), false)
  assert.equal(exclude({ ...sign, x: 298 / width }), false)
  paint(230, 206, 322, 298, [47, 80, 145, 255])
  assert.equal(prepareLandmarks('gits-6581', frame)(sign), false)
})

test('rear-view sampling and box projection agree at both depths', async () => {
  const { RearView } = await import('../src/traffic-ai/rear-view.ts')
  const width = 720,
    height = 480,
    size = 416,
    view = new RearView(width, height, size)
  const rgb = new Uint8ClampedArray(width * height * 4),
    tensor = new Float32Array(size * size * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x)
      rgb[i] = Math.floor(x / 3)
      rgb[i + 1] = Math.floor(y / 2)
      rgb[i + 2] = 10
    }
  view.write(rgb, tensor)
  for (const [x, y] of [
    [100, 36],
    [210, 180],
    [275, 383],
  ]) {
    const box = view.box(x, y, 20, 20),
      i = y * size + x
    assert.ok(Math.abs(tensor[2 * size * size + i] * 3 - box.cx) < 3)
    assert.ok(Math.abs(tensor[size * size + i] * 2 - box.cy) < 2)
    assert.equal(tensor[i], 10)
  }
  assert.ok(view.box(208, 50, 20, 20).w < view.box(208, 355, 20, 20).w)
})

test('manual lanes persist by camera and resetting restores its shared geometry', async () => {
  const { registeredLanes, validManualLane, loadManualLanes, saveManualLanes } =
    await import('../src/traffic-ai/lane-profiles.ts')
  const values = new Map()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  })
  try {
    const quad = [
      [0.1, 0.2],
      [0.2, 0.2],
      [0.4, 0.8],
      [0.1, 0.8],
    ]
    assert.equal(validManualLane(quad), true)
    assert.equal(validManualLane([quad[0], quad[2], quad[1], quad[3]]), false)
    assert.equal(validManualLane([quad[0], quad[1], quad[2], [2, 0.8]]), false)
    assert.equal(registeredLanes('gits-6581').lanes.length, 7)
    assert.equal(saveManualLanes('gits-6581', { lanes: [quad] }), true)
    assert.deepEqual(loadManualLanes('gits-6581'), { lanes: [quad] })
    assert.equal(loadManualLanes('gits-6602'), null)
    assert.equal(saveManualLanes('gits-6581', null), true)
    assert.equal(loadManualLanes('gits-6581'), null)
    assert.equal(registeredLanes('gits-6581').lanes.length, 7)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})

test('Mulwang suppresses visible paint at its calibrated location and keeps an occluding car', async () => {
  const { roadMarkingFilter } = await import(
    '../src/traffic-ai/road-markings.ts'
  )
  const patches = JSON.parse(
    readFileSync(
      new URL('../src/traffic-ai/mulwang-road-paint.json', import.meta.url),
    ),
  )
  const width = 720,
    height = 480
  for (const {
    core: [x, y, w, h],
    padding,
    gray,
  } of patches) {
    const intensities = Buffer.from(gray, 'base64'),
      stride = w + 2 * padding
    const pixels = new Uint8ClampedArray(width * height * 4).fill(120)
    const frame = { width, height, pixels }
    // 카메라가 조금 흔들리고 노출이 달라진 프레임을 구성합니다.
    for (let j = 0; j < h + 2 * padding; j++)
      for (let i = 0; i < stride; i++) {
        const value = Math.round(intensities[j * stride + i] * 0.76 + 19)
        pixels.set(
          [value, value, value, 255],
          4 * ((y - padding + j - 1) * width + x - padding + i + 1),
        )
      }
    const candidate = {
      x: (x + 1) / width,
      y: (y - 1) / height,
      w: w / width,
      h: h / height,
      score: 0.9,
      kind: 2,
    }
    assert.equal(roadMarkingFilter('gits-6581', frame)(candidate), true)
    assert.equal(roadMarkingFilter('gits-6602', frame)(candidate), false)
    assert.equal(
      roadMarkingFilter('gits-6581', frame)({ ...candidate, w: 0.12, h: 0.16 }),
      false,
    )
    // 옆 차체와 도색을 함께 감싼 상자 안에서는 아스팔트가 보이지 않습니다.
    for (let j = y - 3; j < y + h + 2; j++)
      for (let i = x + w + 1; i <= x + w + 5; i++)
        pixels.set([15, 38, 60, 255], 4 * (j * width + i))
    assert.equal(
      roadMarkingFilter(
        'gits-6581',
        frame,
      )({ ...candidate, w: (w + 5) / width }),
      false,
    )
    for (let j = y - 1; j < y + h; j++)
      for (let i = x + 1; i <= x + w; i++)
        pixels.set(
          j < y + h * 0.45 ? [34, 49, 66, 255] : [224, 228, 235, 255],
          4 * (j * width + i),
        )
    assert.equal(roadMarkingFilter('gits-6581', frame)(candidate), false)
  }
})

test('Wolgot follows two through lanes from the far edge and adds the right turn at the split', () => {
  const { lanes, labels, detailRegions } = profile['gits-6578']
  assert.deepEqual(
    labels.map((l) => l.direction),
    ['정왕IC', '정왕IC', '정왕IC', '시청', '시청'],
  )
  const points = [
    [261, 2],
    [279, 2],
    [238, 30],
    [257, 30],
    [204, 130],
    [237, 130],
    [265, 130],
    [180, 337],
    [282, 321],
    [327, 314],
    [385, 301],
    [442, 301],
    [234, 319],
    [160, 240],
  ]
  assert.deepEqual(
    measure(
      lanes,
      points.map(([x, y]) => box(x / 720, y / 480)),
      1.5,
    ).assignments,
    [1, 2, 1, 2, 0, 1, 2, 0, 1, 2, 3, 4, -1, -1],
  )
  assert.equal(detailRegions[0].bounds[1], 0)
})

test('Gunja adds the left turn first and the right turn next; Yeonseong omits curbside parking', () => {
  const { lanes, labels } = profile['gits-6590']
  assert.deepEqual(
    labels.map((l) => l.movement),
    [
      '우회전 전용',
      '직진 · 바깥쪽',
      '직진 · 안쪽',
      '좌회전 전용',
      '1차로',
      '2차로',
    ],
  )
  const inEachStage = [
    [115, 128],
    [127, 127],
    [127, 149],
    [148, 147],
    [162, 144],
    [145, 186],
    [170, 182],
    [193, 179],
    [219, 175],
    [242, 172],
    [258, 170],
    [295, 182],
    [360, 220],
    [415, 248],
  ]
  assert.deepEqual(
    measure(
      lanes,
      inEachStage.map(([x, y]) => box(x / 720, y / 480)),
      1.5,
    ).assignments,
    [1, 2, 1, 2, 3, 0, 1, 2, 3, 4, 5, -1, -1, -1],
  )
  for (const id of ['gits-6578', 'gits-6590']) {
    const { detailRegions, lanes } = profile[id]
    for (const {
      bounds: [left, top, right, bottom],
      lanes: ids,
    } of detailRegions) {
      assert.ok(
        left >= 0 &&
          top >= 0 &&
          right <= 1 &&
          bottom <= 1 &&
          right > left &&
          bottom > top,
      )
      assert.ok(
        ids.length > 0 && ids.every((i) => Number.isInteger(i) && lanes[i]),
      )
    }
    assert.equal(
      new Set(detailRegions.flatMap((r) => r.lanes)).size,
      lanes.length,
    )
  }
})

test('a narrow turn-lane entrance uses the neighboring through lane for perspective', () => {
  const turn = [
    [0.49, 0.1],
    [0.5, 0.1],
    [0.5, 0.4],
    [0.5, 0.9],
    [0.3, 0.9],
    [0.3, 0.4],
  ]
  const through = [
    [0.5, 0.1],
    [0.7, 0.1],
    [0.7, 0.9],
    [0.5, 0.9],
  ]
  const cars = [0.2, 0.35, 0.5, 0.65, 0.8].map((y) => box(0.48, y))
  const { counts, occupancy } = measure([turn, through], cars, 1.5, { 0: 1 })
  assert.deepEqual(counts, [5, 0])
  assert.equal(occupancy[0], 5 / 6)
})

test('Wolgot follows the same moving vehicle through missed scans and counts only detector observations', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true)
  const width = 144,
    height = 90
  const detected = (x) => ({
    x: x / width,
    y: 0.4,
    w: 20 / width,
    h: 18 / height,
    kind: 2,
    score: 0.83,
  })
  function sample(n) {
    const x0 = 12 + n * 3
    const pixels = new Uint8Array(width * height).fill(40)
    for (let y = 0; y < 18; y++)
      for (let x = 0; x < 20; x++)
        pixels[(36 + y) * width + x0 + x] = 70 + ((x * 37 + y * 59) % 150)
    tracker.push({ time: n * 0.08, width, height, pixels })
    return detected(x0)
  }
  const first = sample(0)
  tracker.observe([first], 0, true)
  const id = tracker.visible[0].trackId
  assert.ok(Number.isInteger(id))
  for (let n = 1; n <= 12; n++) {
    const car = sample(n)
    if (n === 12) tracker.observe([{ ...car, inTransit: true }], n * 0.08, true)
    else if (n % 2 === 0)
      assert.deepEqual(tracker.observe([], n * 0.08, true), [])
    assert.equal(tracker.visible.length, 1)
    assert.equal(tracker.visible[0].trackId, id)
    assert.ok(Math.abs(tracker.visible[0].x - car.x) < 0.025)
    if (n === 7) assert.ok(tracker.searchTarget(n * 0.08))
  }
  const cut = {
    time: 1.04,
    width,
    height,
    pixels: new Uint8Array(width * height).fill(245),
  }
  assert.equal(tracker.push(cut), true)
  assert.deepEqual(tracker.visible, [])
  assert.deepEqual(tracker.observe([first], 0.96, true), [])
})

test('new detections on the crossing need motion and never occupy an approach lane', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const { inLane } = await import('../src/traffic-ai/metrics.ts')
  const { lanes, trackingAreas } = profile['gits-6578']
  for (const [x, y] of [
    [310, 370],
    [85, 410],
    [470, 385],
  ]) {
    const car = { ...box(x / 720, y / 480), inTransit: true }
    assert.ok(trackingAreas.some((p) => inLane(x / 720, y / 480, p)))
    assert.deepEqual(measure(lanes, [car], 1.5).assignments, [-1])
    const tracker = new FrameFollower(true)
    for (const time of [0, 0.1, 0.2]) {
      tracker.push({
        time,
        width: 120,
        height: 80,
        pixels: new Uint8Array(120 * 80).fill(40),
      })
      tracker.observe([car], time, true)
      assert.deepEqual(tracker.visible, [])
    }
  }
  for (const [x, y] of [
    [211, 380],
    [620, 299],
  ]) {
    assert.ok(trackingAreas.every((p) => !inLane(x / 720, y / 480, p)))
  }
})

test('a short occlusion keeps the ID, while an empty roadway releases the predicted box', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true),
    width = 130,
    height = 80
  function frame(n, visible) {
    const pixels = new Uint8Array(width * height).fill(20)
    if (visible)
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 18; x++)
          pixels[(30 + y) * width + 15 + n * 2 + x] =
            80 + ((x * 7 + y * 19 + x * y * 3) % 170)
    tracker.push({ time: n * 0.06, width, height, pixels })
  }
  function detected(n) {
    return {
      x: (15 + n * 2) / width,
      y: 30 / height,
      w: 18 / width,
      h: 16 / height,
      kind: 2,
      score: 0.91,
    }
  }
  frame(0, true)
  tracker.observe([detected(0)], 0, true)
  const id = tracker.visible[0].trackId
  for (let n = 1; n <= 5; n++) frame(n, n !== 3 && n !== 4)
  tracker.observe([detected(5)], 0.3, true)
  assert.equal(tracker.visible.length, 1)
  assert.equal(tracker.visible[0].trackId, id)
  for (let n = 6; n <= 11; n++) {
    frame(n, false)
    assert.deepEqual(tracker.observe([], n * 0.06, true), [])
  }
  assert.deepEqual(tracker.visible, [])
})

test('motion selects a road patch for the model without creating a vehicle observation', async () => {
  const { movingRegions } = await import('../src/traffic-ai/moving-region.ts')
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true)
  for (let i = 0; i <= 6; i++) {
    const width = 160,
      height = 110,
      pixels = new Uint8Array(width * height).fill(35)
    if (i >= 5)
      for (let y = 42; y < 58; y++)
        for (let x = 45; x < 66; x++) pixels[y * width + x + 3 * i] = 175
    tracker.push({ time: i * 0.1, width, height, pixels })
  }
  const target = tracker.searchTarget(0.6, movingRegions)
  assert.ok(target && target.x * 160 < 75 && (target.x + target.w) * 160 > 77)
  assert.deepEqual(tracker.visible, [])
  assert.deepEqual(tracker.observe([], 0.6, true), [])
})

const stoppedBox = { x: 0.2, y: 0.3, w: 0.2, h: 0.25, kind: 2, score: 0.8 }
function stoppedFrame(time, offset = 0, visible = true, light = 0) {
  const width = 120,
    height = 80,
    pixels = new Uint8Array(width * height).fill(28 + light)
  if (visible)
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 24; x++)
        pixels[(24 + y) * width + 24 + x + offset] =
          65 + ((x * 13 + y * 7 + x * y * 3) % 135) + light
  return { time, width, height, pixels }
}

test('a stopped car keeps its box and ID across detector gaps without adding synthetic counts', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true)
  tracker.push(stoppedFrame(0))
  tracker.observe([stoppedBox], 0, true)
  const id = tracker.visible[0].trackId
  for (let n = 1; n <= 48; n++) {
    const time = n / 10
    tracker.push(stoppedFrame(time, 0, true, n % 4))
    if (n === 4 || n === 32) {
      const jittered = { ...stoppedBox, x: 0.211, w: 0.19 }
      assert.equal(tracker.observe([jittered], time, true).length, 1)
    } else {
      assert.deepEqual(tracker.observe([], time, false), [])
      assert.deepEqual(tracker.observe([], time, true), [])
    }
    assert.deepEqual(tracker.visible, [{ ...stoppedBox, trackId: id }])
    if (n === 18) assert.ok(tracker.searchTarget(time))
  }
  // 실제 차체가 옮겨 가면 같은 번호로 따라가고, 빈 노면에는 상자를 남기지 않습니다.
  for (let n = 1; n <= 3; n++) {
    const time = 4.8 + n * 0.08
    tracker.push(stoppedFrame(time, 2 * n))
    tracker.observe([], time, true)
    assert.equal(tracker.visible[0]?.trackId, id)
    assert.ok(Math.abs(tracker.visible[0].x - (0.2 + (2 * n) / 120)) < 0.012)
  }
  for (let n = 0; n < 6; n++)
    tracker.push(stoppedFrame(5.12 + n * 0.08, 0, false))
  assert.deepEqual(tracker.visible, [])
})

test('same-frame detection passes cannot renew a stop indefinitely, and a vacated stop clears immediately', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  for (const vacated of [true, false]) {
    const tracker = new FrameFollower(true)
    tracker.push(stoppedFrame(0))
    tracker.observe([stoppedBox], 0, false)
    tracker.observe([stoppedBox], 0, true)
    for (let n = 1; n <= 17; n++) {
      tracker.push(stoppedFrame(n * 0.1))
      tracker.observe([], n * 0.1, true)
    }
    assert.equal(tracker.visible.length, 1)
    if (vacated) {
      tracker.push(stoppedFrame(1.8, 0, false))
      assert.deepEqual(tracker.visible, [])
      tracker.observe([stoppedBox], 1.7, true)
      assert.deepEqual(tracker.visible, [])
    } else {
      for (let n = 18; n <= 24; n++) tracker.push(stoppedFrame(n * 0.1))
      assert.deepEqual(tracker.visible, [])
    }
  }
})

test('one merged queue detection cannot replace two independently verified stopped vehicles', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true)
  const rear = { ...stoppedBox, x: 0.41 }
  function frame(t) {
    const f = stoppedFrame(t)
    for (let y = 24; y < 44; y++)
      for (let x = 49; x < 73; x++)
        f.pixels[y * f.width + x] = 110 + ((x * 17 + y * 21) % 100)
    return f
  }
  tracker.push(frame(0))
  tracker.observe([stoppedBox, rear], 0, true)
  const boxes = tracker.visible
  for (const time of [0.08, 0.16, 0.24, 0.32]) tracker.push(frame(time))
  tracker.observe([stoppedBox, rear], 0.32, true)
  for (const time of [0.4, 0.48, 0.56, 0.64]) {
    tracker.push(frame(time))
    assert.deepEqual(
      tracker.observe([{ ...stoppedBox, w: 0.42 }], time, true),
      [],
    )
    assert.deepEqual(tracker.visible, boxes)
  }
})

test('a one-pixel camera shake and an exposure change do not shift a verified waiting car', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true)
  tracker.push(stoppedFrame(0))
  tracker.observe([stoppedBox], 0, true)
  const parked = tracker.visible
  for (let n = 1; n <= 22; n++) {
    const time = n * 0.1
    tracker.push(
      stoppedFrame(
        time,
        n > 3 ? (n % 3) - 1 : 0,
        n !== 22,
        n % 2 === 0 ? 10 : 0,
      ),
    )
    tracker.observe(n === 3 ? [stoppedBox] : [], time, true)
    assert.deepEqual(tracker.visible, n === 22 ? [] : parked)
  }
})

test('an interrupted decoder or a matching new clip retains only vehicles still present', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true),
    second = { ...stoppedBox, x: 0.68 }
  function scene(t, withSecond) {
    const frame = stoppedFrame(t)
    if (withSecond)
      for (let y = 24; y < 44; y++)
        for (let x = 82; x < 105; x++)
          frame.pixels[y * 120 + x] = 50 + ((x * 13 + y * 19 + x * y) % 152)
    return frame
  }
  f.push(scene(0, true))
  f.observe([stoppedBox, second], 0, true)
  const ids = f.visible.map((b) => b.trackId)
  for (const t of [0.1, 0.2, 0.3]) f.push(scene(t, true))
  f.observe([stoppedBox, second], 0.3, true)
  assert.equal(f.push(scene(1.4, false)), true)
  assert.deepEqual(
    f.visible.map((b) => b.trackId),
    [ids[0]],
  )
  assert.deepEqual(f.observe([], 1.4, true), [])
  assert.equal(f.push(scene(0.02, false), true), true)
  assert.deepEqual(
    f.visible.map((b) => b.trackId),
    [ids[0]],
  )
  assert.equal(f.has(1.4), false)
  const cut = scene(0.8, false)
  cut.pixels.fill(235)
  assert.equal(f.push(cut), true)
  assert.deepEqual(f.visible, [])
})

test('continuously verified waiting vehicles do not time out after eight seconds', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  f.push(stoppedFrame(0))
  f.observe([stoppedBox], 0, true)
  const id = f.visible[0].trackId
  for (let n = 1; n <= 115; n++) {
    const t = n / 10
    f.push(stoppedFrame(t))
    const observations = f.observe(n === 3 ? [stoppedBox] : [], t, true)
    assert.equal(observations.length, n === 3 ? 1 : 0)
    assert.equal(f.visible[0]?.trackId, id)
  }
  f.push(stoppedFrame(11.6, 0, false))
  assert.deepEqual(f.visible, [])
})

test('a confirmed car can be matched under the same ID after a brief occlusion', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  f.push(stoppedFrame(0))
  f.observe([stoppedBox], 0, true)
  const id = f.visible[0].trackId
  for (const t of [0.1, 0.2, 0.3]) f.push(stoppedFrame(t))
  f.observe([stoppedBox], 0.3, true)
  f.push(stoppedFrame(0.4, 0, false))
  assert.equal(f.visible.length, 0)
  f.push(stoppedFrame(0.5))
  f.observe([stoppedBox], 0.5, true)
  assert.equal(f.visible[0].trackId, id)
})

test('optical tracking continues during model misses and retains the visible part at the screen edge', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const tracker = new FrameFollower(true),
    width = 160,
    height = 80,
    w = 24,
    h = 20
  let id
  for (let n = 0; n <= 68; n++) {
    const x0 = 35 + n * 2,
      y0 = 25,
      pixels = new Uint8Array(width * height).fill(25)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w && x + x0 < width; x++)
        pixels[(y + y0) * width + x + x0] =
          65 + ((x * 13 + y * 7 + x * y * 3) % 135)
    const t = n * 0.08
    tracker.push({ time: t, width, height, pixels })
    tracker.observe(
      n === 0 || n === 3
        ? [
            {
              x: x0 / width,
              y: y0 / height,
              w: w / width,
              h: h / height,
              kind: 2,
              score: 0.87,
            },
          ]
        : [],
      t,
      true,
    )
    if (!n) id = tracker.visible[0].trackId
    if (n <= 55) {
      assert.equal(tracker.visible[0]?.trackId, id, 'frame ' + n)
      assert.ok(
        Math.abs(tracker.visible[0].x * width - x0) < 5,
        'position ' + n,
      )
      assert.ok(tracker.visible[0].x + tracker.visible[0].w <= 1.00001)
    }
  }
  assert.deepEqual(tracker.visible, [])
})

test('a large exposure change on the same image preserves IDs while a flat replacement clears them', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  function frame(t, extra) {
    const a = stoppedFrame(t)
    for (let i = 0; i < a.pixels.length; i++)
      a.pixels[i] = Math.min(
        255,
        a.pixels[i] + (a.pixels[i] === 28 ? i % 54 : 0) + extra,
      )
    return a
  }
  f.push(frame(0, 0))
  f.observe([stoppedBox], 0, true)
  for (const t of [0.1, 0.2, 0.3]) f.push(frame(t, 0))
  f.observe([stoppedBox], 0.3, true)
  const initial = f.visible
  assert.equal(f.push(frame(0.4, 52)), false)
  assert.deepEqual(f.visible, initial)
  const cut = frame(0.5, 52)
  cut.pixels.fill(0)
  assert.equal(f.push(cut), true)
  assert.deepEqual(f.visible, [])
})

test('the visible vehicle count and flow verdict use the same IDs and assigned lanes', async () => {
  const { countVisibleVehicles, LaneMotion, queueGrade, congestionGrade } =
    await import('../src/traffic-ai/metrics.ts')
  const left = [
    [0, 0],
    [0.5, 0],
    [0.5, 1],
    [0, 1],
  ]
  const right = [
    [0.5, 0],
    [1, 0],
    [1, 1],
    [0.5, 1],
  ]
  const stopped = Array.from({ length: 6 }, (_, i) => ({
    ...stoppedBox,
    trackId: i + 1,
  }))
  const lanes = [left, right]
  const m = new LaneMotion()
  let flow
  for (let i = 0; i <= 8; i++)
    flow = m.update(
      stopped,
      stopped.map(() => 0),
      i * 0.2,
      1.5,
      2,
    )
  const snapshot = countVisibleVehicles(lanes, stopped, left, flow.motionById)
  assert.deepEqual(snapshot.counts, [6, 0])
  assert.equal(snapshot.rearCount, 0)
  assert.equal(queueGrade(6, snapshot.observed[0], snapshot.slow[0], 6), '높음')
  assert.equal(congestionGrade(17, true, 6, 6, 6, true), '높음')
  assert.equal(queueGrade(6, 6, 0, 6), '낮음')
  assert.equal(queueGrade(6, 2, 2, 6), '흐름 확인 중')
  const changed = countVisibleVehicles(
    lanes,
    [
      { ...stopped[0], x: 0.6 },
      { ...stopped[1], trackId: 88 },
    ],
    undefined,
    flow.motionById,
  )
  assert.deepEqual(changed.counts, [1, 1])
  assert.deepEqual(changed.slow, [0, 0])
  assert.deepEqual(changed.observed, [0, 0])
})

test('classification holds through conflicting frames and corrects after consistent distinct observations', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  let id
  for (const [n, kind] of [
    2, 5, 7, 2, 5, 7, 2, 7, 7, 7, 7, 7, 7, 7,
  ].entries()) {
    const t = n * 0.1
    f.push(stoppedFrame(t))
    for (let i = 0; i < 4; i++) f.observe([{ ...stoppedBox, kind }], t, i === 3)
    if (!n) id = f.visible[0].trackId
    assert.equal(f.visible[0].trackId, id)
    if (n < 8) assert.equal(f.visible[0].kind, 2)
  }
  assert.equal(f.visible[0].kind, 7)
  f.push(stoppedFrame(1.4))
  assert.equal(f.visible[0].kind, 7)
})

test('a visible vehicle returning beyond a calibrated sign recovers its ID without counting it while hidden', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const sign = { x: 0.37, y: 0.27, w: 0.27, h: 0.34 }
  for (const [region, recover] of [
    [sign, true],
    [undefined, false],
  ]) {
    const f = new FrameFollower(true, region)
    let id
    for (let n = 0; n <= 28; n++) {
      const t = n * 0.1,
        visible = n <= 6 || n === 28
      f.push(stoppedFrame(t, n * 2, visible))
      f.observe(
        visible ? [{ ...stoppedBox, x: stoppedBox.x + (n * 2) / 120 }] : [],
        t,
        true,
      )
      if (!n) id = f.visible[0].trackId
      if (n === 19) {
        assert.deepEqual(f.visible, [])
        assert.deepEqual(f.observedVehicles, [])
      }
    }
    assert.equal(f.visible.length, 1)
    assert.equal(f.visible[0].trackId === id, recover)
  }
})

test('police sign filtering requires a verified panel and keeps narrower or taller vehicles', async () => {
  const { prepareLandmarks, signOccluder } = await import(
    '../src/traffic-ai/landmarks.ts'
  )
  const width = 720,
    height = 480
  const pixels = new Uint8ClampedArray(width * height * 4).fill(50)
  const b = (x, y, w, h) => ({
    x: x / width,
    y: y / height,
    w: w / width,
    h: h / height,
    kind: 7,
    score: 0.6,
  })
  const large = b(197, 204, 99, 67)
  assert.ok(signOccluder('gits-6590'))
  assert.equal(signOccluder('gits-6578'), undefined)
  assert.equal(
    prepareLandmarks('gits-6590', { width, height, pixels })(large),
    false,
  )
  for (let x = 206; x < 291; x++) {
    const cy = 240 - Math.round((x - 210) * 0.105)
    for (let y = cy - 13; y <= cy + 13; y++)
      pixels.set([30, 100, 210, 255], (y * width + x) * 4)
  }
  const reject = prepareLandmarks('gits-6590', { width, height, pixels })
  assert.equal(reject(large), true)
  assert.equal(reject(b(215, 210, 40, 58)), false)
  assert.equal(reject(b(202, 216, 98, 106)), false)
})

test('a smaller box around the same stopped vehicle keeps one ID when a nearby car is present', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  const nextCar = { ...stoppedBox, y: 0.03 }
  const small = { ...stoppedBox, x: 0.25, y: 0.39, w: 0.1, h: 0.12 }
  f.push(stoppedFrame(0))
  f.observe([stoppedBox, nextCar], 0, true)
  const id = f.visible[0].trackId
  f.push(stoppedFrame(0.1))
  f.observe([small, nextCar], 0.1, true)
  assert.equal(f.visible.length, 2)
  assert.equal(f.visible[0].trackId, id)
})

test('a confirmed vehicle with uncertain class is immediately counted and labelled after corroboration', async () => {
  const { FrameFollower } = await import('../src/traffic-ai/follow.ts')
  const f = new FrameFollower(true)
  for (const t of [0, 0.1]) {
    f.push(stoppedFrame(t))
    for (const complete of [false, true])
      f.observe([{ ...stoppedBox, score: 0.4 }], t, complete)
    assert.equal(f.visible.length, 1)
    assert.equal(f.visible[0].kind, t === 0 ? -1 : 2)
  }
})

test('police night markings only suppress a matching exposed road patch', async () => {
  const { roadMarkingFilter } = await import(
    '../src/traffic-ai/road-markings.ts'
  )
  const samples = JSON.parse(
    readFileSync(
      new URL(
        '../src/traffic-ai/police-night-road-patterns.json',
        import.meta.url,
      ),
    ),
  )
  const width = 720,
    height = 480
  for (const {
    name,
    core: [x, y, w, h],
    padding,
    gray,
  } of samples) {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(40)
    const frame = { width, height, pixels }
    const values = Buffer.from(gray, 'base64')
    const stride = w + 2 * padding
    assert.equal(values.length, stride * (h + 2 * padding))
    const dx = 1,
      dy = -1
    for (let row = 0; row < h + 2 * padding; row++) {
      for (let col = 0; col < stride; col++) {
        const v = Math.round(values[row * stride + col] * 1.12 + 5)
        pixels.set(
          [v, v, v, 255],
          4 * ((y + dy - padding + row) * width + x + dx - padding + col),
        )
      }
    }
    const box = {
      x: (x + dx) / width,
      y: (y + dy) / height,
      w: w / width,
      h: h / height,
      kind: 2,
      score: 0.7,
    }
    const rejects = () => roadMarkingFilter('gits-6590', frame)(box)
    assert.equal(rejects(), true, name + ' exposed')
    assert.equal(
      roadMarkingFilter('gits-6578', frame)(box),
      false,
      name + ' other camera',
    )
    const original = pixels.slice()
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < Math.ceil(w / 2); col++) {
        const colour = row < h / 2 ? [32, 37, 43, 255] : [240, 222, 189, 255]
        pixels.set(colour, 4 * ((y + dy + row) * width + x + dx + col))
      }
    }
    assert.equal(rejects(), false, name + ' partially covered by a vehicle')
    pixels.set(original)
    assert.equal(rejects(), true, name + ' exposed again')
  }
})

test('the signal between police lanes E and F must match both the housing and the surrounding road', async () => {
  const { roadMarkingFilter } = await import(
    '../src/traffic-ai/road-markings.ts'
  )
  const [signal] = JSON.parse(
    readFileSync(
      new URL('../src/traffic-ai/police-signal-patterns.json', import.meta.url),
    ),
  )
  const [x, y, w, h] = signal.core
  const width = 720,
    height = 480,
    padding = signal.padding
  const pixels = new Uint8ClampedArray(width * height * 4).fill(50)
  const intensities = Buffer.from(signal.gray, 'base64'),
    stride = w + 2 * padding
  assert.equal(intensities.length, stride * (h + 2 * padding))
  for (let j = 0; j < h + 2 * padding; j++) {
    for (let i = 0; i < stride; i++) {
      const value = Math.round(intensities[j * stride + i] * 0.85 + 10)
      pixels.set(
        [value, value, value, 255],
        4 * ((y - padding + j) * width + x - padding + i),
      )
    }
  }
  // 실제 오탐 상자처럼 신호등 위쪽 노면까지 포함합니다.
  const box = {
    x: (x - 3) / width,
    y: (y - 7) / height,
    w: (w + 7) / width,
    h: (h + 7) / height,
    kind: 2,
    score: 0.75,
  }
  const frame = { pixels, width, height }
  assert.ok(roadMarkingFilter('gits-6590', frame)(box))
  assert.equal(roadMarkingFilter('gits-6581', frame)(box), false)
  assert.equal(
    roadMarkingFilter('gits-6590', frame)({ ...box, w: 80 / width }),
    false,
  )
  const empty = pixels.slice()
  // 신호등 뒷면은 그대로 보이고 그 위로 차량 지붕과 불빛이 나타납니다.
  for (let row = y - 7; row < y; row++)
    for (let col = x - 3; col < x + w; col++)
      pixels.set(
        row < y - 3 ? [40, 41, 46, 255] : [225, 195, 172, 255],
        4 * (row * width + col),
      )
  assert.equal(roadMarkingFilter('gits-6590', frame)(box), false)
  pixels.set(empty)
  assert.ok(roadMarkingFilter('gits-6590', frame)(box))
})
