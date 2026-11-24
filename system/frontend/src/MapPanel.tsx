import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import {
  Cctv,
  Crosshair,
  Layers2,
  Map as MapIcon,
  MapPin,
  Minus,
  Plus,
  Navigation2,
} from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import bounds from '../public/map/bounds.json'
import basemap from '../public/map/siheung.webp'
import type { Camera } from './LiveCctv'
import { displayName, type Intersection } from './types'

const places: [number, number, string][] = [
  [37.393, 126.74, '월곶동'],
  [37.367, 126.78, '군자동'],
  [37.383, 126.785, '장곡동'],
  [37.365, 126.813, '능곡동'],
  [37.405, 126.802, '연성동'],
  [37.393, 126.855, '목감동'],
  [37.35, 126.746, '정왕동'],
  [37.381, 126.84, '물왕호수'],
  [37.411, 126.773, '포동'],
  [37.405, 126.826, '매화동'],
  [37.405, 126.733, '소래습지생태공원'],
]
type Props = {
  cameras: Camera[]
  onLive: (id?: string) => void
  sites: Intersection[]
  active: string | null
  onOpen: (s: Intersection) => void
}
export function MapPanel({ sites, active, onOpen, cameras, onLive }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const cameraIcon = useRef<HTMLSpanElement>(null)
  const map = useRef<L.Map | null>(null)
  const [labels, setLabels] = useState(true)
  const [showSites, setShowSites] = useState(false)
  const openCamera = useRef(onLive)
  openCamera.current = onLive
  const [layers, setLayers] = useState(false)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  const fitOnResize = useRef(true)
  const pointsInView = useRef<Pick<Intersection, 'lat' | 'lon'>[]>([])

  function fit(m: L.Map, points: Pick<Intersection, 'lat' | 'lon'>[]) {
    if (!m.getContainer().clientWidth) {
      fitOnResize.current = true
      return
    }
    if (!points.length) {
      m.setView([37.38, 126.805], 13, { animate: false })
      fitOnResize.current = true
      return
    }
    m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon])), {
      padding: [38, 50],
      maxZoom: 14.5,
      animate: false,
    })
    fitOnResize.current = true
  }
  useEffect(() => {
    if (!host.current) return
    const m = L.map(host.current, {
      zoomControl: false,
      zoomAnimation: false,
      attributionControl: false,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 11.5,
      maxZoom: 15.5,
      scrollWheelZoom: false,
      maxBounds: bounds as L.LatLngBoundsExpression,
      maxBoundsViscosity: 1,
    })
    map.current = m
    m.setView([37.38, 126.805], 13, { animate: false })
    L.imageOverlay(basemap, bounds as L.LatLngBoundsExpression, {
      interactive: false,
    }).addTo(m)
    L.control
      .scale({ imperial: false, position: 'bottomleft', maxWidth: 75 })
      .addTo(m)
    m.on('movestart zoomstart', () => {
      fitOnResize.current = false
    })
    const observer = new ResizeObserver(() => {
      if (!m.getContainer().clientWidth) return
      const fitted = fitOnResize.current
      m.invalidateSize({ pan: false })
      if (fitted) fit(m, pointsInView.current)
    })
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      m.remove()
      map.current = null
    }
  }, [])
  useEffect(() => {
    pointsInView.current = showSites ? [...sites, ...cameras] : cameras
    if (map.current) fit(map.current, pointsInView.current)
  }, [sites, cameras, showSites])
  useEffect(() => {
    const m = map.current
    if (!m || !labels) return
    const group = L.layerGroup().addTo(m)
    for (const [lat, lon, name] of places) {
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'place-name',
          html: name,
          iconSize: [90, 20],
          iconAnchor: [45, 10],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -800,
      }).addTo(group)
    }
    return () => {
      group.remove()
    }
  }, [labels])
  useEffect(() => {
    if (!map.current || !showSites) return
    const selectedSite = sites.find((s) => s.id === active)
    if (
      selectedSite &&
      !map.current.getBounds().contains([selectedSite.lat, selectedSite.lon])
    ) {
      map.current.panTo([selectedSite.lat, selectedSite.lon])
    }
    const group = L.layerGroup().addTo(map.current)
    for (const site of sites) {
      const selected = site.id === active
      const marker = L.marker([site.lat, site.lon], {
        icon: L.divIcon({
          className: 'site-pin' + (selected ? ' chosen' : ''),
          html: '●',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: displayName(site),
        alt: displayName(site),
        zIndexOffset: selected ? 900 : 0,
      })
        .addTo(group)
        .on('click', () => onOpenRef.current(site))
      marker.bindTooltip(displayName(site), {
        permanent: selected,
        direction: 'top',
        offset: [0, -15],
        className: 'site-tip',
      })
    }
    return () => {
      group.remove()
    }
  }, [sites, active, showSites])
  useEffect(() => {
    if (!map.current || !cameraIcon.current) return
    const group = L.layerGroup().addTo(map.current)
    for (const c of cameras) {
      const text = document.createElement('span')
      text.textContent = c.name + ' · ' + c.district
      const marker = L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          className: 'city-camera-pin',
          html: cameraIcon.current.innerHTML,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: c.name,
        alt: c.name,
        zIndexOffset: 1000,
      })
        .bindTooltip(text)
        .addTo(group)
        .on('click', () => openCamera.current(c.id))
      marker.getElement()?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          openCamera.current(c.id)
        }
      })
    }
    return () => {
      group.remove()
    }
  }, [cameras])
  return (
    <section className="card map-card" id="camera-map">
      <div className="panel-head">
        <div className="panel-title">
          <MapIcon />
          <h2>교차로 관제 지도</h2>
        </div>
        <div className="map-actions">
          <button className="subtle-button live-open" onClick={() => onLive()}>
            <Cctv size={15} />
            실시간 CCTV
          </button>
          <div className="layer-wrap">
            <button
              className="subtle-button"
              aria-label="지도 설정"
              aria-expanded={layers}
              onClick={() => setLayers(!layers)}
            >
              <Layers2 size={15} />
              <span>지도 설정</span>
            </button>
            {layers && (
              <div className="layer-menu">
                <label>
                  <input
                    type="checkbox"
                    checked={labels}
                    onChange={(e) => setLabels(e.target.checked)}
                  />{' '}
                  지역명 표시
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showSites}
                    onChange={(e) => setShowSites(e.target.checked)}
                  />
                  스마트교차로 조사 지점
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
      <span ref={cameraIcon} hidden>
        <Cctv size={17} strokeWidth={2} />
      </span>
      <div className="map-surface">
        <div
          className="leaflet-host"
          ref={host}
          aria-label="시흥시 중부권 스마트교차로 지도"
        />
        <div className="map-region">
          <MapPin size={14} />
          시흥시 중부권
        </div>
        <div className="north">
          <Navigation2 size={15} fill="currentColor" />N
        </div>
        <div className="map-tools">
          <button aria-label="지도 확대" onClick={() => map.current?.zoomIn()}>
            <Plus />
          </button>
          <button aria-label="지도 축소" onClick={() => map.current?.zoomOut()}>
            <Minus />
          </button>
          <button
            aria-label="중부권 CCTV 전체 보기"
            onClick={() =>
              map.current &&
              fit(map.current, showSites ? [...sites, ...cameras] : cameras)
            }
          >
            <Crosshair />
          </button>
        </div>
        <div className="attribution">
          <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
            OpenFreeMap
          </a>{' '}
          ·{' '}
          <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">
            © OpenMapTiles
          </a>{' '}
          ·{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap
          </a>
        </div>
      </div>
      <div className="map-foot">
        <span>
          <i className="legend-dot brand-dot" />
          시내 교차로 CCTV {cameras.length}대
        </span>
        {showSites && (
          <span>
            <i className="legend-dot gray" />
            스마트교차로 조사 지점
          </span>
        )}
        <small>시흥시 · 경기도교통정보센터</small>
      </div>
    </section>
  )
}
