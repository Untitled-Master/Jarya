import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { 
  Upload, 
  MapPin, 
  Route, 
  Mountain, 
  Clock, 
  Ruler, 
  Trash2, 
  Play, 
  Pause, 
  Video, 
  Square, 
  Cuboid, 
  MapIcon, 
  Compass, 
  Gauge,
  Settings2,
  Hourglass,
  Film
} from 'lucide-react'

// Map Tile Cache Helper System
const tileCache = new Map()

function getTileImage(z, x, y) {
  const key = `${z}/${x}/${y}`
  if (tileCache.has(key)) return tileCache.get(key)

  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`
  
  const entry = { img, loaded: false }
  tileCache.set(key, entry)
  
  img.onload = () => {
    entry.loaded = true
  }
  return entry
}

function latLngToTile(lat, lon, zoom) {
  const x = (lon + 180) / 360 * Math.pow(2, zoom)
  const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)
  return { x, y }
}

function drawMapTilesToCanvas(ctx, centerLat, centerLon, zoom, width, height) {
  const centerTile = latLngToTile(centerLat, centerLon, zoom)
  const tileSize = 256
  
  const startTileX = Math.floor(centerTile.x - (width / 2) / tileSize) - 1
  const endTileX = Math.ceil(centerTile.x + (width / 2) / tileSize) + 1
  const startTileY = Math.floor(centerTile.y - (height / 2) / tileSize) - 1
  const endTileY = Math.ceil(centerTile.y + (height / 2) / tileSize) + 1

  for (let tx = startTileX; tx <= endTileX; tx++) {
    for (let ty = startTileY; ty <= endTileY; ty++) {
      const tile = getTileImage(zoom, tx, ty)
      if (tile && tile.loaded) {
        const dx = (tx - centerTile.x) * tileSize + width / 2
        const dy = (ty - centerTile.y) * tileSize + height / 2
        ctx.drawImage(tile.img, dx, dy, tileSize, tileSize)
      }
    }
  }
}

async function preloadAllTiles(points, zoom, width, height) {
  if (points.length === 0) return
  const lats = points.map(p => p.lat), lons = points.map(p => p.lon)
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2
  const centerTile = latLngToTile(centerLat, centerLon, zoom)
  
  const tileSize = 256
  const startTileX = Math.floor(centerTile.x - (width / 2) / tileSize) - 2
  const endTileX = Math.ceil(centerTile.x + (width / 2) / tileSize) + 2
  const startTileY = Math.floor(centerTile.y - (height / 2) / tileSize) - 2
  const endTileY = Math.ceil(centerTile.y + (height / 2) / tileSize) + 2

  const promises = []
  for (let tx = startTileX; tx <= endTileX; tx++) {
    for (let ty = startTileY; ty <= endTileY; ty++) {
      const tile = getTileImage(zoom, tx, ty)
      if (!tile.loaded) {
        promises.push(new Promise((resolve) => {
          tile.img.onload = () => {
            tile.loaded = true
            resolve()
          }
          tile.img.onerror = () => resolve()
        }))
      }
    }
  }
  await Promise.all(promises)
}

function calculateBestZoom(points, width, height) {
  if (points.length === 0) return 13
  const lats = points.map(p => p.lat), lons = points.map(p => p.lon)
  const maxLat = Math.max(...lats), minLat = Math.min(...lats)
  const maxLon = Math.max(...lons), minLon = Math.min(...lons)
  
  const latDiff = maxLat - minLat
  const lonDiff = maxLon - minLon
  
  for (let z = 18; z > 2; z--) {
    const meterPerPx = 156543.03392 * Math.cos(minLat * Math.PI / 180) / Math.pow(2, z)
    const widthInMeters = width * meterPerPx
    const heightInMeters = height * meterPerPx
    
    const routeWidthMeters = lonDiff * 111320 * Math.cos(minLat * Math.PI / 180)
    const routeHeightMeters = latDiff * 111320
    
    if (routeWidthMeters < widthInMeters * 0.7 && routeHeightMeters < heightInMeters * 0.7) {
      return z
    }
  }
  return 12
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function parseGPX(xmlText) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'text/xml')
  const trkpts = doc.querySelectorAll('trkpt')
  const points = []
  for (const pt of trkpts) {
    const lat = parseFloat(pt.getAttribute('lat'))
    const lon = parseFloat(pt.getAttribute('lon'))
    const ele = pt.querySelector('ele')
    const time = pt.querySelector('time')
    points.push({
      lat, lon,
      ele: ele ? parseFloat(ele.textContent) : null,
      time: time ? new Date(time.textContent) : null,
    })
  }
  return points
}

function preparePointsWithMeters(rawPoints) {
  if (rawPoints.length === 0) return []
  const refLat = rawPoints[0].lat
  const refLon = rawPoints[0].lon
  const mpd = 111320
  const mpdLon = mpd * Math.cos(refLat * Math.PI / 180)

  let cumulativeDistance = 0
  const processed = []

  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i]
    if (i > 0) {
      cumulativeDistance += haversineDistance(rawPoints[i-1].lat, rawPoints[i-1].lon, p.lat, p.lon)
    }
    const x = (p.lon - refLon) * mpdLon
    const z = (p.lat - refLat) * mpd
    const y = p.ele !== null && p.ele !== undefined ? p.ele : 0

    processed.push({
      ...p,
      x,
      y,
      z,
      dist: cumulativeDistance
    })
  }
  return processed
}

function calculateStats(points, endIndex) {
  const slice = points.slice(0, endIndex + 1)
  if (slice.length < 2) return { distance: 0, elevationGain: 0, duration: 0, avgPace: null, currentSpeed: null }
  let distance = 0, elevationGain = 0
  for (let i = 1; i < slice.length; i++) {
    distance += haversineDistance(slice[i - 1].lat, slice[i - 1].lon, slice[i].lat, slice[i].lon)
    if (slice[i].ele !== null && slice[i - 1].ele !== null && slice[i].ele > slice[i - 1].ele) elevationGain += slice[i].ele - slice[i - 1].ele
  }
  const startTime = slice[0].time, endTime = slice[slice.length - 1].time
  let duration = 0, avgPace = null, currentSpeed = null
  if (startTime && endTime) {
    duration = (endTime - startTime) / 1000
    if (duration > 0 && distance > 0) { 
      avgPace = duration / 60 / (distance / 1000)
      currentSpeed = (distance / 1000) / (duration / 3600) 
    }
  }
  if (slice.length >= 2) {
    const last = slice[slice.length - 1], prev = slice[slice.length - 2]
    const segDist = haversineDistance(prev.lat, prev.lon, last.lat, last.lon)
    if (last.time && prev.time) { 
      const segTime = (last.time - prev.time) / 1000
      if (segTime > 0) currentSpeed = (segDist / 1000) / (segTime / 3600) 
    }
  }
  return { distance, elevationGain, duration, avgPace, currentSpeed }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatPace(minPerKm) {
  if (!minPerKm || isNaN(minPerKm)) return '--'
  const m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60)
  return `${m}:${s.toString().padStart(2, '0')} /km`
}

function FitBounds({ points, simIndex }) {
  const map = useMap()
  const fitted = useRef(false)
  if (simIndex !== undefined && simIndex >= 0) return null
  if (points.length > 1 && !fitted.current) {
    fitted.current = true
    map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon])), { padding: [40, 40] })
  }
  return null
}

function PanToPosition({ position }) {
  const map = useMap()
  useEffect(() => { if (position) map.panTo(position, { animate: true, duration: 0.3 }) }, [map, position])
  return null
}

function SimulationRunner({ points, simIndex }) {
  const map = useMap()
  const markerRef = useRef(null)
  useEffect(() => {
    if (simIndex < 0 || simIndex >= points.length) return
    const pos = [points[simIndex].lat, points[simIndex].lon]
    if (!markerRef.current) {
      markerRef.current = L.circleMarker(pos, { radius: 7, color: '#FC5200', fillColor: '#FC5200', fillOpacity: 1, weight: 3 }).addTo(map)
      const pulse = L.circleMarker(pos, { radius: 14, color: '#FC5200', fillColor: '#FC5200', fillOpacity: 0.15, weight: 0 }).addTo(map)
      markerRef.current._pulse = pulse
      let growing = true
      const animatePulse = () => {
        if (!markerRef.current || !markerRef.current._pulse) return
        const r = markerRef.current._pulse.getRadius()
        if (growing && r >= 20) growing = false
        if (!growing && r <= 14) growing = true
        markerRef.current._pulse.setRadius(growing ? r + 0.25 : r - 0.25)
        markerRef.current._animFrame = requestAnimationFrame(animatePulse)
      }
      markerRef.current._animFrame = requestAnimationFrame(animatePulse)
    } else {
      markerRef.current.setLatLng(pos)
      if (markerRef.current._pulse) markerRef.current._pulse.setLatLng(pos)
    }
  }, [map, points, simIndex])
  useEffect(() => {
    return () => {
      if (markerRef.current) {
        if (markerRef.current._animFrame) cancelAnimationFrame(markerRef.current._animFrame)
        if (markerRef.current._pulse) map.removeLayer(markerRef.current._pulse)
        map.removeLayer(markerRef.current)
        markerRef.current = null
      }
    }
  }, [map])
  return null
}

function project3DPoint(px, py, pz, camera, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale) {
  const dx = px - camera.x
  const dy = py - camera.y
  const dz = pz - camera.z
  const pCamX = dx * rx + dy * ry + dz * rz
  const pCamY = dx * ux + dy * uy + dz * uz
  const pCamZ = dx * fx + dy * fy + dz * fz
  if (pCamZ < 1.0) return null
  return {
    x: width / 2 + (pCamX / pCamZ) * fovScale,
    y: height / 2 - (pCamY / pCamZ) * fovScale,
    depth: pCamZ,
  }
}

// ── Module-level camera state for smooth interpolation ──────────────────
let _smoothCam = null

// ── 3rd person chase cam rebuilt for video-game feel ──────────────────
function renderChaseCam3D(ctx, points, simIndex, width, height, totalDistance, elapsed = 0) {
  ctx.clearRect(0, 0, width, height)

  // ── Sky & atmosphere ─────────────────────────────────────────────────
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height)
  skyGrad.addColorStop(0, '#070b15')
  skyGrad.addColorStop(0.35, '#0f172a')
  skyGrad.addColorStop(0.5, '#1e293b')
  skyGrad.addColorStop(0.53, '#0f172a')
  skyGrad.addColorStop(1, '#030509')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, width, height)

  if (points.length < 2 || simIndex < 0) return

  // ── Interpolate position along route ─────────────────────────────────
  const idx = Math.min(Math.floor(simIndex), points.length - 1)
  const frac = simIndex - idx
  let cx = points[idx].x, cy = points[idx].y, cz = points[idx].z
  if (idx < points.length - 1 && frac > 0) {
    const n = points[idx + 1]
    cx += (n.x - points[idx].x) * frac
    cy += (n.y - points[idx].y) * frac
    cz += (n.z - points[idx].z) * frac
  }

  // ── Smoothed heading (average over window) ───────────────────────────
  let hdx = 0, hdz = 0
  const win = Math.min(10, points.length)
  let hCount = 0
  for (let i = -win; i <= win; i++) {
    const cur = idx + i, nxt = idx + i + 1
    if (cur >= 0 && nxt < points.length) {
      hdx += points[nxt].x - points[cur].x
      hdz += points[nxt].z - points[cur].z
      hCount++
    }
  }
  let heading = 0
  if (hCount > 0 && (hdx !== 0 || hdz !== 0)) heading = Math.atan2(hdx, hdz)
  const cosH = Math.cos(heading)
  const sinH = Math.sin(heading)

  // ── 3rd person camera ────────────────────────────────────────────────
  const followDist = 140
  const heightOffset = 55
  const lookAhead = 50

  const desX = cx - sinH * followDist
  const desZ = cz - cosH * followDist
  const desY = cy + heightOffset

  if (!_smoothCam) {
    _smoothCam = { x: desX, y: desY, z: desZ }
  }
  const lerpSpd = 0.06
  _smoothCam.x += (desX - _smoothCam.x) * lerpSpd
  _smoothCam.y += (desY - _smoothCam.y) * lerpSpd
  _smoothCam.z += (desZ - _smoothCam.z) * lerpSpd
  const cam = _smoothCam

  const lookX = cx + sinH * lookAhead
  const lookY = cy + 3
  const lookZ = cz + cosH * lookAhead

  let fx = lookX - cam.x, fy = lookY - cam.y, fz = lookZ - cam.z
  const flen = Math.sqrt(fx * fx + fy * fy + fz * fz)
  fx /= flen; fy /= flen; fz /= flen

  let rx = fz, ry = 0, rz = -fx
  const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz)
  rx /= rlen; rz /= rlen

  const ux = ry * fz - rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy - ry * fx

  const fovScale = Math.min(width, height) * 0.9

  // ── Ground grid with fog ─────────────────────────────────────────────
  const groundY = cy - 2
  const gridSpacing = 40
  const gridRadius = 600
  const gMinX = Math.floor((cam.x - gridRadius) / gridSpacing) * gridSpacing
  const gMaxX = Math.ceil((cam.x + gridRadius) / gridSpacing) * gridSpacing
  const gMinZ = Math.floor((cam.z - gridRadius) / gridSpacing) * gridSpacing
  const gMaxZ = Math.ceil((cam.z + gridRadius) / gridSpacing) * gridSpacing

  for (let x = gMinX; x <= gMaxX; x += gridSpacing) {
    ctx.beginPath()
    let first = true
    for (let z = gMinZ; z <= gMaxZ; z += 8) {
      const p = project3DPoint(x, groundY, z, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
      if (p) {
        if (first) { ctx.moveTo(p.x, p.y); first = false } else ctx.lineTo(p.x, p.y)
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.025)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  for (let z = gMinZ; z <= gMaxZ; z += gridSpacing) {
    ctx.beginPath()
    let first = true
    for (let x = gMinX; x <= gMaxX; x += 8) {
      const p = project3DPoint(x, groundY, z, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
      if (p) {
        if (first) { ctx.moveTo(p.x, p.y); first = false } else ctx.lineTo(p.x, p.y)
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.025)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // ── Project route to 3D ──────────────────────────────────────────────
  const proj = points.map((p, i) => {
    const pp = project3DPoint(p.x, p.y, p.z, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
    const gp = project3DPoint(p.x, groundY, p.z, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
    return pp ? { p: pp, gp, idx: i } : null
  }).filter(Boolean)

  const completed = proj.filter(p => p.idx <= idx)
  const remaining = proj.filter(p => p.idx > idx)

  // ── Ground road (completed) ──────────────────────────────────────────
  if (completed.length >= 2) {
    ctx.save()
    ctx.strokeStyle = 'rgba(252, 82, 0, 0.06)'
    ctx.lineWidth = 32
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    completed.forEach((p, i) => {
      if (p.gp) { if (i === 0) ctx.moveTo(p.gp.x, p.gp.y); else ctx.lineTo(p.gp.x, p.gp.y) }
    })
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.strokeStyle = 'rgba(252, 82, 0, 0.15)'
    ctx.lineWidth = 14
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    completed.forEach((p, i) => {
      if (p.gp) { if (i === 0) ctx.moveTo(p.gp.x, p.gp.y); else ctx.lineTo(p.gp.x, p.gp.y) }
    })
    ctx.stroke()
    ctx.restore()
  }

  // ── Remaining route (ghost on ground) ────────────────────────────────
  if (remaining.length >= 2) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 6
    ctx.setLineDash([4, 10])
    ctx.lineCap = 'round'
    ctx.beginPath()
    remaining.forEach((p, i) => {
      if (p.gp) { if (i === 0) ctx.moveTo(p.gp.x, p.gp.y); else ctx.lineTo(p.gp.x, p.gp.y) }
    })
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  // ── Elevated 3D trail ────────────────────────────────────────────────
  if (remaining.length >= 2) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.lineWidth = 3
    ctx.setLineDash([5, 10])
    ctx.lineCap = 'round'
    ctx.beginPath()
    remaining.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.p.x, p.p.y); else ctx.lineTo(p.p.x, p.p.y)
    })
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  if (completed.length >= 2) {
    ctx.save()
    ctx.strokeStyle = 'rgba(252, 82, 0, 0.12)'
    ctx.lineWidth = 20
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    completed.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.p.x, p.p.y); else ctx.lineTo(p.p.x, p.p.y)
    })
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.strokeStyle = 'rgba(252, 82, 0, 0.3)'
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    completed.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.p.x, p.p.y); else ctx.lineTo(p.p.x, p.p.y)
    })
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.strokeStyle = '#FC5200'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    completed.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.p.x, p.p.y); else ctx.lineTo(p.p.x, p.p.y)
    })
    ctx.stroke()
    ctx.restore()
  }

  // ── Current position marker ──────────────────────────────────────────
  const curP = project3DPoint(cx, cy, cz, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
  const shdP = project3DPoint(cx, groundY, cz, cam, rx, ry, rz, ux, uy, uz, fx, fy, fz, width, height, fovScale)
  if (curP) {
    if (shdP) {
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(shdP.x, shdP.y, 18, 8, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    const pulse = 0.5 + 0.5 * Math.sin((elapsed || 0) * 0.08)
    ctx.save()
    ctx.beginPath()
    ctx.arc(curP.x, curP.y - 8, 22 + pulse * 6, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(252,82,0,${0.05 + pulse * 0.06})`
    ctx.fill()
    ctx.restore()
    ctx.save()
    ctx.beginPath()
    ctx.arc(curP.x, curP.y - 8, 12, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(252,82,0,0.2)'
    ctx.fill()
    ctx.restore()
    ctx.save()
    ctx.beginPath()
    ctx.arc(curP.x, curP.y - 8, 7, 0, Math.PI * 2)
    ctx.fillStyle = '#FC5200'
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.restore()
  }

  // ── HUD: Top-left info card ──────────────────────────────────────────
  const stats = calculateStats(points, idx)
  const distKm = stats.distance / 1000
  const speed = stats.currentSpeed || 0
  const grade = idx > 0 && points[idx].dist > points[idx - 1].dist
    ? ((cy - points[idx - 1].y) / (points[idx].dist - points[idx - 1].dist)) * 100
    : 0

  const cardX = 20, cardY = 20, cardW = 200, cardH = 100
  ctx.save()
  ctx.fillStyle = 'rgba(10,12,20,0.88)'
  ctx.beginPath()
  ctx.roundRect(cardX, cardY, cardW, cardH, 12)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = '#FC5200'
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cardX + 16, cardY + 1)
  ctx.lineTo(cardX + cardW - 16, cardY + 1)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.font = '800 28px system-ui,-apple-system,sans-serif'
  ctx.textAlign = 'left'
  const speedW = ctx.measureText(speed.toFixed(1)).width
  ctx.fillText(speed.toFixed(1), cardX + 16, cardY + 38)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '600 13px system-ui,-apple-system,sans-serif'
  ctx.fillText('km/h', cardX + 18 + speedW, cardY + 38)
  ctx.restore()

  const subs = [
    { l: 'Heading', v: `${(heading * 180 / Math.PI).toFixed(0)}°` },
    { l: 'Grade', v: `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%` },
    { l: 'Altitude', v: `${cy.toFixed(0)}m` },
  ]
  subs.forEach((m, i) => {
    const mx = cardX + 16 + i * 60
    ctx.save()
    ctx.fillStyle = 'rgba(252,82,0,0.7)'
    ctx.font = '500 9px system-ui,-apple-system,sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(m.l.toUpperCase(), mx, cardY + 58)
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 14px system-ui,-apple-system,sans-serif'
    ctx.fillText(m.v, mx, cardY + 80)
    ctx.restore()
  })

  // ── HUD: Bottom metrics bar ──────────────────────────────────────────
  const bH = 70, bY = height - bH - 16, bW = width - 40, bX = 20
  ctx.save()
  ctx.fillStyle = 'rgba(10,12,20,0.88)'
  ctx.beginPath()
  ctx.roundRect(bX, bY, bW, bH, 16)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()

  const bCols = [
    { l: 'Distance', v: distKm.toFixed(2), u: 'km' },
    { l: 'Elevation', v: `${Math.round(stats.elevationGain)}`, u: 'm' },
    { l: 'Time', v: formatDuration(stats.duration) },
    { l: 'Pace', v: stats.avgPace ? formatPace(stats.avgPace) : '--' },
  ]
  const colW = bW / bCols.length
  bCols.forEach((m, i) => {
    const mx = bX + colW * i + colW / 2
    ctx.save()
    ctx.fillStyle = 'rgba(252,82,0,0.6)'
    ctx.font = '500 9px system-ui,-apple-system,sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(m.l.toUpperCase(), mx, bY + 22)
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 18px system-ui,-apple-system,sans-serif'
    ctx.fillText(m.v, mx, bY + 44)
    if (m.u) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '400 10px system-ui,-apple-system,sans-serif'
      ctx.fillText(m.u, mx, bY + 58)
    }
    ctx.restore()
  })

  // Watermark
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.font = '600 10px system-ui,-apple-system,sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('gpx.run', width / 2, height - 6)
  ctx.restore()
}

function renderVideoFrame(ctx, points, simIndex, width, height, totalDistance, viewType = 'realistic', zoomLevel = 14, elapsed = 0) {
  const W = width, H = height

  // ── Helpers ───────────────────────────────────────────────────────────────
  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
  }

  function lerp(a, b, t) { return a + (b - a) * t }

  if (viewType === '3d') {
    renderChaseCam3D(ctx, points, simIndex, W, H, totalDistance, elapsed)
    return
  }

  // ── Background — dark map ─────────────────────────────────────────────────
  if (viewType === 'realistic') {
    ctx.fillStyle = '#1e2433'
    ctx.fillRect(0, 0, W, H)
    const lats = points.map(p => p.lat), lons = points.map(p => p.lon)
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2
    const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2
    drawMapTilesToCanvas(ctx, centerLat, centerLon, zoomLevel, W, H)
  } else {
    ctx.fillStyle = '#1e2433'
    ctx.fillRect(0, 0, W, H)

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.035)'
    ctx.lineWidth = 0.5
    for (let x = 0; x < W; x += 28) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    }
    for (let y = 0; y < H; y += 28) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }
  }

  // ── Route Projection ──────────────────────────────────────────────────────
  const lats = points.map(p => p.lat)
  const lons = points.map(p => p.lon)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const cLat = (minLat + maxLat) / 2
  const cLon = (minLon + maxLon) / 2
  const latSpan = maxLat - minLat || 0.001
  const lonSpan = maxLon - minLon || 0.001
  const pad = 100
  const scale = Math.min((W - pad * 2) / lonSpan, (H - pad * 2) / latSpan)

  const project = (lat, lon) => [
    W / 2 + (lon - cLon) * scale,
    H / 2 - (lat - cLat) * scale
  ]

  const projected = points.map(p => project(p.lat, p.lon))
  const clampedIndex = Math.min(simIndex, projected.length - 2)
  const frac = simIndex - clampedIndex
  const [interpX, interpY] = [
    lerp(projected[clampedIndex][0], projected[clampedIndex + 1][0], frac),
    lerp(projected[clampedIndex][1], projected[clampedIndex + 1][1], frac)
  ]

  const completed = [...projected.slice(0, clampedIndex + 1), [interpX, interpY]]
  const remaining = projected.slice(clampedIndex + 1)

  // ── Route Lines ───────────────────────────────────────────────────────────

  // Remaining — dashed ghost
  if (remaining.length >= 1) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 3
    ctx.setLineDash([5, 8])
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(interpX, interpY)
    remaining.forEach(p => ctx.lineTo(p[0], p[1]))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  // Completed — wide outer glow
  ctx.save()
  ctx.strokeStyle = 'rgba(252,82,0,0.18)'
  ctx.lineWidth = 20
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  completed.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]))
  ctx.stroke()
  ctx.restore()

  // Completed — mid glow
  ctx.save()
  ctx.strokeStyle = 'rgba(252,82,0,0.35)'
  ctx.lineWidth = 10
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  completed.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]))
  ctx.stroke()
  ctx.restore()

  // Completed — core Strava orange
  ctx.save()
  ctx.strokeStyle = '#FC5200'
  ctx.lineWidth = 4.5
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  completed.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]))
  ctx.stroke()
  ctx.restore()

  // Start dot — green
  if (projected.length > 0) {
    const [sx, sy] = projected[0]
    ctx.save()
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2)
    ctx.fillStyle = '#00c46a'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
    ctx.restore()
  }

  // Current position — animated pulse rings + dot
  const pulse = 0.5 + 0.5 * Math.sin((elapsed || 0) * 0.12)
  ctx.save()
  ctx.beginPath(); ctx.arc(interpX, interpY, 18 + pulse * 4, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(252,82,0,${0.08 + pulse * 0.07})`; ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.beginPath(); ctx.arc(interpX, interpY, 10, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(252,82,0,0.25)'; ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.beginPath(); ctx.arc(interpX, interpY, 6, 0, Math.PI * 2)
  ctx.fillStyle = '#FC5200'; ctx.fill()
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
  ctx.restore()

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = calculateStats(points, simIndex)
  const pct = totalDistance > 0 ? Math.min(stats.distance / totalDistance, 1) : 0
  const distKm = stats.distance / 1000

  // Avg pace (min/km)
  const paceTotal = stats.duration > 0 && distKm > 0
    ? stats.duration / 60 / distKm
    : 0
  const paceMin = Math.floor(paceTotal)
  const paceSec = Math.floor((paceTotal - paceMin) * 60)
  const paceStr = distKm > 0.01
    ? `${paceMin}:${String(paceSec).padStart(2, '0')}`
    : '--'

  const hrValue = stats.currentHeartRate != null
    ? `${Math.round(stats.currentHeartRate)}`
    : '--'
  const elevValue = `${Math.round(stats.elevationGain)}`

  // ── TOP HUD ───────────────────────────────────────────────────────────────

  // Activity type pill — centered
  const pillW = 90, pillH = 28, pillY = 16
  ctx.save()
  ctx.fillStyle = '#FC5200'
  roundRect((W - pillW) / 2, pillY, pillW, pillH, 14); ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = '700 12px -apple-system, "SF Pro Display", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('RUNNING', W / 2, pillY + 18.5)
  ctx.restore()

  // LIVE badge — top right
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  roundRect(W - 64, pillY, 48, 28, 8); ctx.fill()
  const liveBlink = Math.sin((elapsed || 0) * 0.15) > 0
  ctx.beginPath(); ctx.arc(W - 52, pillY + 14, 4, 0, Math.PI * 2)
  ctx.fillStyle = liveBlink ? '#ff3b30' : '#a0160d'; ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = '600 11px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('LIVE', W - 44, pillY + 18.5)
  ctx.restore()

  // Elapsed time — large centered
  ctx.save()
  ctx.fillStyle = '#fff'
  ctx.font = '800 52px -apple-system, "SF Pro Display", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(formatDuration(stats.duration), W / 2, pillY + 82)
  ctx.restore()

  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = '500 12px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('ELAPSED TIME', W / 2, pillY + 100)
  ctx.restore()

  // ── BOTTOM CARD ───────────────────────────────────────────────────────────
  const cardH = 228
  const cardY = H - cardH - 16
  const cardX = 16
  const cardW = W - 32

  // Card background
  ctx.save()
  ctx.fillStyle = 'rgba(10,12,20,0.92)'
  roundRect(cardX, cardY, cardW, cardH, 22); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1; ctx.stroke()
  ctx.restore()

  // Orange top accent line
  ctx.save()
  ctx.strokeStyle = '#FC5200'
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cardX + 32, cardY + 1)
  ctx.lineTo(cardX + cardW - 32, cardY + 1)
  ctx.stroke()
  ctx.restore()

  // Progress bar
  const barX = cardX + 20, barY = cardY + 16
  const barW = cardW - 40, barH = 6
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.1)'
  roundRect(barX, barY, barW, barH, 3); ctx.fill()
  if (pct > 0) {
    ctx.fillStyle = '#FC5200'
    roundRect(barX, barY, barW * pct, barH, 3); ctx.fill()
    ctx.beginPath()
    ctx.arc(barX + barW * pct, barY + barH / 2, 5.5, 0, Math.PI * 2)
    ctx.fillStyle = '#FF8C5A'; ctx.fill()
  }
  ctx.restore()

  // Completion % label
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '500 11px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(`${(pct * 100).toFixed(1)}% complete`, barX + barW, barY + barH + 14)
  ctx.restore()

  // Separator below bar
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cardX + 20, cardY + 46)
  ctx.lineTo(cardX + cardW - 20, cardY + 46)
  ctx.stroke()
  ctx.restore()

  // Grid dividers
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cardX + cardW / 2, cardY + 50)
  ctx.lineTo(cardX + cardW / 2, cardY + cardH - 16)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cardX + 20, cardY + 62 + 78)
  ctx.lineTo(cardX + cardW - 20, cardY + 62 + 78)
  ctx.stroke()
  ctx.restore()

  // 2×2 Metrics
  const metrics = [
    { label: 'Distance',   value: distKm.toFixed(2),  unit: 'km'  },
    { label: 'Avg Pace',   value: paceStr,             unit: '/km' },
    { label: 'Heart Rate', value: hrValue,             unit: 'bpm' },
    { label: 'Elevation',  value: elevValue,           unit: 'm'   },
  ]

  metrics.forEach((m, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const cx = cardX + (col === 0 ? cardW * 0.25 : cardW * 0.75)
    const baseY = cardY + 62 + row * 78

    // Label
    ctx.save()
    ctx.fillStyle = 'rgba(252,82,0,0.75)'
    ctx.font = '500 11px -apple-system, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(m.label.toUpperCase(), cx, baseY)
    ctx.restore()

    // Value
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.font = `800 ${m.value.length > 4 ? 26 : 30}px -apple-system, "SF Pro Display", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(m.value, cx, baseY + 34)
    ctx.restore()

    // Unit
    ctx.save()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '400 12px -apple-system, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(m.unit, cx, baseY + 52)
    ctx.restore()
  })

  // Watermark
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,0.2)'
  ctx.font = '600 11px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('gpx.run', W / 2, H - 6)
  ctx.restore()
}

export default function GpxViewer() {
  const [points, setPoints] = useState(() => {
    try {
      const saved = localStorage.getItem('gpx_last_route')
      if (saved) {
        const data = JSON.parse(saved)
        if (data.points && data.points.length >= 2) return data.points
      }
    } catch {}
    return []
  })
  const [fileName, setFileName] = useState(() => {
    try {
      const saved = localStorage.getItem('gpx_last_route')
      if (saved) return JSON.parse(saved).fileName || ''
    } catch {}
    return ''
  })
  const [rawContent, setRawContent] = useState(() => {
    try {
      const saved = localStorage.getItem('gpx_last_route')
      if (saved) return JSON.parse(saved).rawContent || ''
    } catch {}
    return ''
  })
  const [stats, setStats] = useState(() => {
    if (points.length >= 2) return calculateStats(points, points.length - 1)
    return null
  })
  
  const [simIndex, setSimIndex] = useState(-1)
  const [simStats, setSimStats] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const [isDragOver, setIsDragOver] = useState(false)
  
  const animRef = useRef(null)
  const simIndexRef = useRef(-1)
  const isSimulatingRef = useRef(false)
  const [simSpeed, setSimSpeed] = useState(10)
  const [isPaused, setIsPaused] = useState(false)

  // Export Settings State
  const [showExportModal, setShowExportModal] = useState(false)
  const [exportSpeed, setExportSpeed] = useState(50)
  const [exportStyle, setExportStyle] = useState('realistic') 

  // Recording Engine State
  const [recording, setRecording] = useState(false)
  const [recordingProgress, setRecordingProgress] = useState(0)
  const [recordingError, setRecordingError] = useState('')
  const [estTimeRemaining, setEstTimeRemaining] = useState(0)
  const [tilesPreloading, setTilesPreloading] = useState(false)

  const recorderRef = useRef(null)
  const recCanvasRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const recordAnimRef = useRef(null)
  const recordIdxRef = useRef(null)

  const [viewMode, setViewMode] = useState(() => {
    try { const s = localStorage.getItem('gpx_view_mode'); return s === '3d' ? '3d' : '2d' } catch { return '2d' }
  })

  const [hoverIndex, setHoverIndex] = useState(null)

  const totalDistance = useMemo(() => {
    if (points.length < 2) return 0
    let d = 0
    for (let i = 1; i < points.length; i++) {
      d += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon)
    }
    return d
  }, [points])

  const isSimulating = simIndex >= 0
  const displayStats = isSimulating && simStats ? simStats : stats

  const stopSimulation = useCallback(() => {
    isSimulatingRef.current = false
    setIsPaused(false)
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null }
    setSimIndex(-1)
    setSimStats(null)
  }, [])

  const pauseSimulation = useCallback(() => {
    if (isSimulatingRef.current) {
      isSimulatingRef.current = false
      setIsPaused(true)
      if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null }
    }
  }, [])

  const resumeSimulation = useCallback(() => {
    if (points.length < 2 || isSimulatingRef.current) return
    setIsPaused(false)
    isSimulatingRef.current = true
    
    let lastTime = performance.now()
    const hasTimestamps = points[0].time && points[points.length - 1].time

    const tick = (now) => {
      if (!isSimulatingRef.current) return
      const idx = simIndexRef.current
      if (idx >= points.length - 1) { 
        setSimIndex(points.length - 1)
        setSimStats(calculateStats(points, points.length - 1))
        isSimulatingRef.current = false
        return 
      }
      
      const delta = (now - lastTime) / 1000
      lastTime = now
      let advance
      if (hasTimestamps) {
        const timeDiff = ((new Date(points[idx + 1].time) - new Date(points[idx].time)) / 1000) || 1
        advance = delta / (timeDiff / simSpeed)
      } else {
        advance = delta * simSpeed * 1.5
      }

      const nextIdx = Math.min(idx + Math.max(1, Math.round(advance)), points.length - 1)
      simIndexRef.current = nextIdx
      setSimIndex(nextIdx)
      setSimStats(calculateStats(points, nextIdx))
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
  }, [points, simSpeed])

  const startSimulation = useCallback(() => {
    if (points.length < 2) return
    stopSimulation()
    setSimIndex(0)
    setSimStats(calculateStats(points, 0))
    simIndexRef.current = 0
    resumeSimulation()
  }, [points, stopSimulation, resumeSimulation])

  const stopRecording = useCallback(() => {
    if (recordAnimRef.current) { cancelAnimationFrame(recordAnimRef.current); recordAnimRef.current = null }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    setRecording(false)
    setRecordingProgress(0)
    setTilesPreloading(false)
  }, [])

  const startRecording = useCallback(async () => {
    if (points.length < 2) return
    setShowExportModal(false)
    stopRecording()
    stopSimulation()
    setRecordingError('')
    setTilesPreloading(true)
    
    const w = 720
    const h = 1280
    const calculatedZoom = calculateBestZoom(points, w, h)

    if (exportStyle === 'realistic') {
      try {
        await preloadAllTiles(points, calculatedZoom, w, h)
      } catch (e) {
        console.warn('Map tiles preload failed, continuing rendering.', e)
      }
    }
    setTilesPreloading(false)

    try {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      recCanvasRef.current = canvas
      
      const ctx = canvas.getContext('2d')
      const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      const chosen = types.find(t => MediaRecorder.isTypeSupported(t))
      
      if (!chosen) { 
        setRecordingError('Video format not supported inside this browser.')
        return 
      }
      
      const chunks = []
      const stream = canvas.captureStream(30)
      const recorder = new MediaRecorder(stream, { mimeType: chosen, videoBitsPerSecond: 5000000 })
      recorderRef.current = recorder
      
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: chosen })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(fileName || 'route').replace(/\.[^.]+$/, '')}_vertical_tiktok.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
      
      recorder.onerror = () => setRecordingError('Video rendering export process failed.')
      recordIdxRef.current = 0
      setRecording(true)
      setRecordingProgress(0)

      renderVideoFrame(ctx, points, 0, w, h, totalDistance, exportStyle, calculatedZoom, 0)
      
      setTimeout(() => {
        if (previewCanvasRef.current) {
          const pCtx = previewCanvasRef.current.getContext('2d')
          pCtx.clearRect(0, 0, 225, 400)
          pCtx.drawImage(canvas, 0, 0, 225, 400)
        }
      }, 50)

      recorder.start()
      
      const fps = 30
      const frameInterval = 1000 / fps
      let lastFrame = performance.now()
      const startTime = performance.now()

      const tick = (now) => {
        if (!recorderRef.current || recorderRef.current.state === 'inactive') return
        const elapsed = now - lastFrame
        if (elapsed >= frameInterval) {
          lastFrame = now - (elapsed % frameInterval)
          
          const next = Math.min(recordIdxRef.current + Math.max(1, Math.round(exportSpeed / 10)), points.length - 1)
          recordIdxRef.current = next
          
          renderVideoFrame(ctx, points, next, w, h, totalDistance, exportStyle, calculatedZoom, recordIdxRef.current)
          const progress = next / (points.length - 1)
          setRecordingProgress(progress)

          if (previewCanvasRef.current) {
            const pCtx = previewCanvasRef.current.getContext('2d')
            pCtx.clearRect(0, 0, 225, 400)
            pCtx.drawImage(canvas, 0, 0, 225, 400)
          }

          if (progress > 0) {
            const timeElapsed = (performance.now() - startTime) / 1000
            const totalEstimatedTime = timeElapsed / progress
            setEstTimeRemaining(Math.max(0, Math.round(totalEstimatedTime - timeElapsed)))
          }

          if (next >= points.length - 1) {
            setTimeout(() => { 
              if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
              setRecording(false)
              setRecordingProgress(1)
            }, 600)
            return
          }
        }
        recordAnimRef.current = requestAnimationFrame(tick)
      }
      recordAnimRef.current = requestAnimationFrame(tick)
    } catch (err) { 
      setRecordingError('Failed to initialize local rendering engine.')
      setRecording(false) 
    }
  }, [points, fileName, totalDistance, exportSpeed, exportStyle, stopRecording, stopSimulation])

  const handleFile = useCallback((file) => {
    stopSimulation()
    stopRecording()
    setError('')
    if (!file || !file.name.toLowerCase().endsWith('.gpx')) { 
      setError('Please upload a valid .gpx format file.')
      return 
    }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target.result
        const parsed = parseGPX(content)
        if (parsed.length < 2) { 
          setError('Selected GPX route does not contain enough track points.')
          setPoints([])
          setStats(null)
          return 
        }
        
        const prepared = preparePointsWithMeters(parsed)
        setPoints(prepared)
        setRawContent(content)
        setStats(calculateStats(prepared, prepared.length - 1))
        try { 
          localStorage.setItem('gpx_last_route', JSON.stringify({ points: prepared, fileName: file.name, rawContent: content })) 
        } catch {}
      } catch (err) { 
        setError('An error occurred while parsing this GPX route.')
        setPoints([])
        setStats(null) 
      }
    }
    reader.readAsText(file)
  }, [stopSimulation, stopRecording])

  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      if (recordAnimRef.current) cancelAnimationFrame(recordAnimRef.current)
      isSimulatingRef.current = false
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    }
  }, [])

  const completedPositions = useMemo(() => {
    if (simIndex < 0) return points.map(p => [p.lat, p.lon])
    return points.slice(0, simIndex + 1).map(p => [p.lat, p.lon])
  }, [points, simIndex])

  const remainingPositions = useMemo(() => {
    if (simIndex < 0) return []
    return points.slice(simIndex).map(p => [p.lat, p.lon])
  }, [points, simIndex])

  const currentPos = simIndex >= 0 && simIndex < points.length ? [points[simIndex].lat, points[simIndex].lon] : null

  // Styled Elevation Chart coordinates to match Strava aesthetic
  const elevationData = useMemo(() => {
    if (points.length < 2) return { pathLine: '', pathFill: '', minEle: 0, maxEle: 0 }
    const elevations = points.map(p => p.ele || 0)
    const minEle = Math.min(...elevations)
    const maxEle = Math.max(...elevations)
    const eleRange = (maxEle - minEle) || 1

    const w = 1000
    const h = 100
    const pad = 4

    const pts = points.map((p, i) => {
      const x = (p.dist / totalDistance) * (w - 2 * pad) + pad
      const y = h - pad - ((p.y - minEle) / eleRange) * (h - 2 * pad)
      return { x, y, idx: i }
    })

    const linePoints = pts.map(p => `${p.x},${p.y}`).join(' L ')
    return {
      points: pts,
      pathLine: `M ${linePoints}`,
      pathFill: `M ${pad},${h} L ${linePoints} L ${w - pad},${h} Z`,
      minEle,
      maxEle
    }
  }, [points, totalDistance])

  const handleElevationScrub = (e, svgEl) => {
    if (!svgEl || points.length < 2) return
    const rect = svgEl.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, clickX / rect.width))
    const targetDist = pct * totalDistance

    let closestIdx = 0
    let minDiff = Infinity
    for (let i = 0; i < points.length; i++) {
      const diff = Math.abs(points[i].dist - targetDist)
      if (diff < minDiff) {
        minDiff = diff
        closestIdx = i
      }
    }

    if (isSimulating) {
      simIndexRef.current = closestIdx
      setSimIndex(closestIdx)
      setSimStats(calculateStats(points, closestIdx))
    } else {
      setSimIndex(closestIdx)
      setSimStats(calculateStats(points, closestIdx))
    }
  }

  const canvas3DRef = useRef(null)

  // Safe animation loop for 3D simulation
  useEffect(() => {
    const canvas = canvas3DRef.current
    if (!canvas || points.length < 2 || viewMode !== '3d' || recording) return

    const ctx = canvas.getContext('2d')
    let frameId
    let ticks = 0

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const r = parent.getBoundingClientRect()
      canvas.width = r.width
      canvas.height = r.height
    }

    resize()
    
    const ro = new ResizeObserver(() => {
      resize()
    })
    
    if (canvas.parentElement) {
      ro.observe(canvas.parentElement)
    }

    const render = () => {
      ticks++
      if (canvas.width > 0 && canvas.height > 0) {
        renderChaseCam3D(
          ctx, 
          points, 
          simIndex >= 0 ? simIndex : points.length - 1, 
          canvas.width, 
          canvas.height, 
          totalDistance,
          ticks
        )
      }
      frameId = requestAnimationFrame(render)
    }
    
    frameId = requestAnimationFrame(render)

    return () => {
      if (frameId) cancelAnimationFrame(frameId)
      ro.disconnect()
    }
  }, [points, viewMode, simIndex, totalDistance, recording])

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">
      {/* Navbar */}
      <header className="sticky top-0 z-40 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur-lg">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-[#FC5200] to-orange-600 flex items-center justify-center shadow-lg shadow-orange-600/20">
              <Route className="w-4.5 h-4.5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-white">gpx.run</span>
                {fileName && (
                  <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 text-[10px] font-medium border border-zinc-700/50 truncate max-w-[140px]">
                    <MapPin className="w-3 h-3 shrink-0" />
                    <span className="truncate">{fileName}</span>
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 font-medium leading-tight">Route viewer &amp; video export</p>
            </div>
          </div>
          {points.length > 0 && !recording && !tilesPreloading && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  inputRef.current?.click()
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-all"
                title="Load another GPX file"
              >
                <Upload className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Open</span>
              </button>
              <div className="w-px h-5 bg-zinc-800 mx-0.5" />
              <button
                onClick={() => {
                  const m = viewMode === '3d' ? '2d' : '3d'
                  setViewMode(m)
                  try { localStorage.setItem('gpx_view_mode', m) } catch {}
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                  viewMode === '3d'
                    ? 'bg-[#FC5200]/10 text-[#FC5200] border-[#FC5200]/20 hover:bg-[#FC5200]/20'
                    : 'text-zinc-400 border-transparent hover:text-zinc-200 hover:bg-zinc-800/60'
                }`}
                title={`Switch to ${viewMode === '3d' ? '2D' : '3D'} view`}
              >
                {viewMode === '3d' ? <MapIcon className="w-3.5 h-3.5" /> : <Cuboid className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{viewMode === '3d' ? 'Map' : '3D'}</span>
              </button>
              <button
                onClick={() => {
                  stopSimulation()
                  setPoints([])
                  setStats(null)
                  setFileName('')
                  setError('')
                  setRawContent('')
                  try { localStorage.removeItem('gpx_last_route') } catch {}
                  if (inputRef.current) inputRef.current.value = ''
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-red-400 hover:bg-red-950/30 transition-all"
                title="Clear route"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Clear</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        
        {/* Render preloader state with high layering */}
        {tilesPreloading && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-10 text-center max-w-lg mx-auto shadow-xl space-y-4">
            <div className="w-10 h-10 border-4 border-t-[#FC5200] border-zinc-800 rounded-full animate-spin mx-auto" />
            <h3 className="text-base font-bold text-white">Preloading Map Tiles</h3>
            <p className="text-xs text-zinc-400 max-w-sm mx-auto">
              Fetching geographic cartography regions of the route bounds for the vertical background canvas...
            </p>
          </div>
        )}

        {/* Dynamic Video Render Mode Overlay Workspace */}
        {recording && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl animate-in fade-in duration-300">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
              
              {/* TikTok Phone Layout Simulation Mirror Preview Container */}
              <div className="lg:col-span-5 flex justify-center">
                <div className="relative border-4 border-zinc-800 bg-zinc-950 rounded-[2.5rem] p-3 shadow-2xl max-w-[260px] aspect-[9/16] overflow-hidden">
                  <div className="absolute top-0 inset-x-0 h-4 bg-zinc-800 rounded-b-xl z-20 mx-auto w-32 flex items-center justify-center">
                    <div className="w-3 h-3 rounded-full bg-zinc-950" />
                  </div>
                  <canvas 
                    ref={previewCanvasRef} 
                    width={225} 
                    height={400} 
                    className="w-full h-full rounded-[2rem] block bg-zinc-900" 
                  />
                </div>
              </div>

              {/* Progress Counters Information Pane */}
              <div className="lg:col-span-7 space-y-6">
                <div className="space-y-2">
                  <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#FC5200]/10 text-[#FC5200] border border-[#FC5200]/20 rounded-full text-xs font-bold uppercase tracking-wider">
                    <Film className="w-3.5 h-3.5" /> Generating TikTok Video
                  </div>
                  <h2 className="text-2xl font-black text-white tracking-tight">Exporting High-Definition MP4</h2>
                  <p className="text-sm text-zinc-400 max-w-md">
                    Please keep this browser window focused. The rendering engine will automatically capture frames and trigger download when completed.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800 shadow-inner">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Estimated Remaining</span>
                    <div className="flex items-center gap-2 text-xl font-bold text-white tracking-tight">
                      <Hourglass className="w-4.5 h-4.5 text-amber-500" />
                      <span>{estTimeRemaining > 0 ? `${estTimeRemaining}s` : 'Computing...'}</span>
                    </div>
                  </div>
                  <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800 shadow-inner">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Warp Speed</span>
                    <div className="flex items-center gap-2 text-xl font-bold text-white tracking-tight">
                      <Gauge className="w-4.5 h-4.5 text-[#FC5200]" />
                      <span>{exportSpeed}x Multiplier</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold text-zinc-400">
                    <span>RENDERING COCKPIT PROGRESS</span>
                    <span>{Math.round(recordingProgress * 100)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
                    <div 
                      className="h-full bg-[#FC5200] rounded-full transition-all duration-150" 
                      style={{ width: `${recordingProgress * 100}%` }} 
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button 
                    onClick={stopRecording} 
                    className="flex items-center justify-center gap-2 px-5 py-2.5 bg-zinc-950 hover:bg-zinc-800 text-rose-500 border border-rose-950/50 rounded-xl text-xs font-bold transition-colors"
                  >
                    <Square className="w-3.5 h-3.5" /> Stop Export
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

        {recordingError && (
          <div className="p-4 rounded-xl text-xs bg-rose-950/50 text-rose-400 border border-rose-900/60 font-medium">
            {recordingError}
          </div>
        )}

        {/* Dynamic Drag Drop Input Zone with Strava Focus Accent */}
        {points.length === 0 && (
          <div
            onDrop={(e) => { e.preventDefault(); setIsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onClick={() => inputRef.current?.click()}
            className={`border border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-300 ${
              isDragOver 
                ? 'border-[#FC5200] bg-[#FC5200]/5 scale-[0.99] shadow-inner' 
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 shadow-sm'
            }`}
          >
            <input ref={inputRef} type="file" accept=".gpx" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} className="hidden" />
            <div className="w-12 h-12 bg-zinc-900 rounded-xl flex items-center justify-center mx-auto mb-4 border border-zinc-800 shadow-sm">
              <Upload className="w-5 h-5 text-zinc-400" />
            </div>
            <p className="text-sm font-semibold text-white">Drag and drop your route GPX file</p>
            <p className="text-xs text-zinc-400 mt-1.5">Supports GPX tracks exported from Garmin, Strava, or Wahoo</p>
          </div>
        )}

        {error && (
          <div className="p-3.5 rounded-xl text-xs bg-rose-950/50 text-rose-400 border border-rose-900/60 font-medium">
            {error}
          </div>
        )}

        {/* Dashboard Grid Statistics Display - Strava Accented */}
        {points.length > 0 && displayStats && !recording && !tilesPreloading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { 
                icon: Ruler, 
                label: 'Cumulative Distance', 
                value: displayStats.distance > 1000 ? `${(displayStats.distance / 1000).toFixed(2)} km` : `${displayStats.distance.toFixed(0)} m`,
                color: 'text-orange-400 bg-orange-950/30 border-orange-900/30' 
              },
              { 
                icon: Mountain, 
                label: 'Elevation Gain', 
                value: `${displayStats.elevationGain.toFixed(0)} m`,
                color: 'text-orange-400 bg-orange-950/30 border-orange-900/30' 
              },
              { 
                icon: Clock, 
                label: isSimulating ? 'Elapsed Duration' : 'Estimated Time', 
                value: formatDuration(displayStats.duration),
                color: 'text-orange-400 bg-orange-950/30 border-orange-900/30' 
              },
              { 
                icon: isSimulating ? Gauge : Route, 
                label: isSimulating ? 'Dynamic Velocity' : 'Average Pace', 
                value: isSimulating && displayStats.currentSpeed != null ? `${displayStats.currentSpeed.toFixed(1)} km/h` : formatPace(displayStats.avgPace),
                color: 'text-orange-400 bg-orange-950/30 border-orange-900/30' 
              },
            ].map(({ icon: Icon, label, value, color }) => (
              <div key={label} className={`p-4 rounded-xl bg-zinc-900/60 border shadow-sm flex items-start gap-3 ${color}`}>
                <div className="p-2 rounded-lg bg-black/40 shrink-0">
                  <Icon className="w-4 h-4 text-[#FC5200]" />
                </div>
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider block mb-0.5 text-zinc-400">{label}</span>
                  <div className="text-base font-bold tracking-tight text-white">{value}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Map Visualization Canvas Window Frame */}
        {points.length > 0 && !recording && !tilesPreloading && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 space-y-4">
              <div className="rounded-2xl overflow-hidden border border-zinc-900 bg-zinc-950 h-[480px] shadow-sm relative">
                {viewMode === '3d' ? (
                  <div className="w-full h-full relative">
                    <canvas 
                      ref={canvas3DRef}
                      id="view3d-canvas" 
                      className="w-full h-full block bg-zinc-950" 
                    />
                  </div>
                ) : (
                  <div className="h-full w-full">
                    <MapContainer center={[points[0].lat, points[0].lon]} zoom={13} zoomControl={false} style={{ height: '100%', width: '100%' }}>
                      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                      <FitBounds points={points} simIndex={simIndex} />
                      {currentPos && <PanToPosition position={currentPos} />}
                      {isSimulating ? (
                        <>
                          {/* Completed route line using core Strava Orange */}
                          <Polyline positions={completedPositions} pathOptions={{ color: '#FC5200', weight: 5.5, opacity: 1 }} />
                          <Polyline positions={remainingPositions} pathOptions={{ color: 'rgba(255, 255, 255, 0.25)', weight: 3.5, opacity: 0.8, dashArray: '6 8' }} />
                          <SimulationRunner points={points} simIndex={simIndex} />
                        </>
                      ) : (
                        <Polyline positions={points.map(p => [p.lat, p.lon])} pathOptions={{ color: '#FC5200', weight: 5, opacity: 1 }} />
                      )}
                    </MapContainer>
                  </div>
                )}
                
                {/* Viewmode Label Badge overlay */}
                <div className="absolute top-3 left-3 z-30 bg-slate-900/95 backdrop-blur-md text-white px-2.5 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-md">
                  <Compass className="w-3.5 h-3.5 text-[#FC5200]" />
                  {viewMode === '3d' ? '3D Flight Render Mode' : '2D Map Layer Mode'}
                </div>
              </div>

              {/* Strava Elegant Elevation Profile Chart */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 shadow-sm">
                <div className="flex justify-between items-center mb-2.5">
                  <div className="flex items-center gap-2">
                    <Mountain className="w-4 h-4 text-zinc-500" />
                    <span className="text-xs font-bold text-zinc-300 tracking-wide uppercase">Elevation Profile</span>
                  </div>
                  <span className="text-[10px] font-semibold text-zinc-500">
                    Range: {elevationData.minEle.toFixed(0)}m — {elevationData.maxEle.toFixed(0)}m
                  </span>
                </div>
                
                {/* Interactive SVG graph */}
                <div className="relative">
                  <svg 
                    className="w-full h-24 overflow-visible cursor-crosshair"
                    viewBox="0 0 1000 100"
                    preserveAspectRatio="none"
                    onClick={(e) => handleElevationScrub(e, e.currentTarget)}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const xPos = e.clientX - rect.left
                      const pct = xPos / rect.width
                      setHoverIndex(Math.min(points.length - 1, Math.max(0, Math.round(pct * (points.length - 1)))))
                    }}
                    onMouseLeave={() => setHoverIndex(null)}
                  >
                    <defs>
                      <linearGradient id="eleGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#FC5200" stopOpacity="0.5"/>
                        <stop offset="100%" stopColor="#FC5200" stopOpacity="0.0"/>
                      </linearGradient>
                    </defs>

                    <path d={elevationData.pathFill} fill="url(#eleGrad)" />
                    <path d={elevationData.pathLine} fill="none" stroke="#FC5200" strokeWidth="2.5" />

                    {/* Interactive Hover coordinate guide line */}
                    {hoverIndex !== null && hoverIndex >= 0 && hoverIndex < points.length && (
                      <line
                        x1={(points[hoverIndex].dist / totalDistance) * 992 + 4}
                        y1="0"
                        x2={(points[hoverIndex].dist / totalDistance) * 992 + 4}
                        y2="100"
                        stroke="rgba(255, 255, 255, 0.15)"
                        strokeWidth="1.5"
                        strokeDasharray="4,4"
                      />
                    )}

                    {/* Simulation Playhead marker */}
                    {simIndex >= 0 && simIndex < points.length && (
                      <circle
                        cx={(points[simIndex].dist / totalDistance) * 992 + 4}
                        cy={100 - 4 - ((points[simIndex].y - elevationData.minEle) / (elevationData.maxEle - elevationData.minEle || 1)) * 92}
                        r="5.5"
                        fill="#FC5200"
                        stroke="#ffffff"
                        strokeWidth="2.5"
                      />
                    )}
                  </svg>
                  
                  {/* Tooltip text block display */}
                  {hoverIndex !== null && points[hoverIndex] && (
                    <div 
                      className="absolute top-1 bg-zinc-950 text-white text-[10px] border border-zinc-800 font-semibold p-1.5 rounded shadow pointer-events-none animate-in fade-in"
                      style={{ 
                        left: `${Math.min(85, Math.max(5, (points[hoverIndex].dist / totalDistance) * 100))}%`,
                        transform: 'translateX(-50%)' 
                      }}
                    >
                      <p>Elev: {points[hoverIndex].y.toFixed(0)} m</p>
                      <p>Dist: {(points[hoverIndex].dist / 1000).toFixed(2)} km</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Sidebar Controller Cards */}
            <div className="space-y-4">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-sm space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-zinc-100 tracking-wide uppercase">Simulation Controls</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">Control preview simulation speed</p>
                </div>

                {/* Main Playback state buttons */}
                <div className="flex gap-2">
                  {!isSimulating ? (
                    <button 
                      onClick={startSimulation} 
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-[#FC5200] text-white hover:bg-[#e04600] transition-all shadow-md"
                    >
                      <Play className="w-4.5 h-4.5" /> Start Sim
                    </button>
                  ) : (
                    <>
                      {isPaused ? (
                        <button 
                          onClick={resumeSimulation} 
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-[#FC5200] text-white hover:bg-[#e04600] transition-all shadow-md"
                        >
                          <Play className="w-4.5 h-4.5" /> Resume
                        </button>
                      ) : (
                        <button 
                          onClick={pauseSimulation} 
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-all"
                        >
                          <Pause className="w-4.5 h-4.5" /> Pause
                        </button>
                      )}
                      
                      <button 
                        onClick={() => { stopSimulation() }} 
                        className="flex items-center justify-center px-4 py-2.5 rounded-xl text-xs font-bold bg-rose-950/40 text-rose-400 border border-rose-900/40 hover:bg-rose-900/30 transition-all"
                      >
                        <Square className="w-4.5 h-4.5" /> Stop
                      </button>
                    </>
                  )}
                </div>

                {/* Speed Multipliers selection strip */}
                <div className="space-y-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Simulation Warp Speed</span>
                  <div className="grid grid-cols-5 gap-1.5">
                    {[1, 5, 10, 25, 50].map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setSimSpeed(s)
                          if (isSimulatingRef.current) {
                            simIndexRef.current = simIndex
                            isSimulatingRef.current = false
                            setTimeout(() => {
                              isSimulatingRef.current = true
                              resumeSimulation()
                            }, 50)
                          }
                        }}
                        className={`py-1.5 rounded-lg text-xs font-bold transition-all border ${
                          simSpeed === s 
                            ? 'bg-[#FC5200] border-[#FC5200] text-white shadow-sm' 
                            : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-zinc-800">
                  <button 
                    onClick={() => setShowExportModal(true)} 
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-zinc-950 text-[#FC5200] border border-[#FC5200]/30 hover:bg-zinc-850 hover:border-[#FC5200] transition-all shadow-md shadow-[#FC5200]/5"
                  >
                    <Video className="w-4 h-4 text-[#FC5200]" /> Configure TikTok Export
                  </button>
                </div>
              </div>

              {/* File details context panel card */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-sm space-y-3.5">
                <div>
                  <h3 className="text-sm font-bold text-zinc-100 tracking-wide uppercase">File Meta Info</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">Active coordinate file descriptors</p>
                </div>
                
                <div className="space-y-2 text-xs font-semibold">
                  <div className="flex justify-between py-1.5 border-b border-zinc-800">
                    <span className="text-zinc-500">File Name</span>
                    <span className="text-zinc-200 truncate max-w-[160px]">{fileName || 'None'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-zinc-800">
                    <span className="text-zinc-500">Waypoints</span>
                    <span className="text-zinc-200">{points.length} nodes</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-zinc-800">
                    <span className="text-zinc-500">Avg Altitude</span>
                    <span className="text-zinc-200">
                      {(points.reduce((acc, p) => acc + (p.y || 0), 0) / points.length).toFixed(0)} m
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Export Settings Configuration Modal with Overriding layer z-[9999] */}
      {showExportModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2 pb-1 border-b border-zinc-800">
              <Settings2 className="w-5 h-5 text-[#FC5200]" />
              <h3 className="text-base font-bold text-white">TikTok Export Settings</h3>
            </div>

            {/* Speed selection section */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-zinc-400 block uppercase">Video Generation Speed</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Slow (10x)', val: 10 },
                  { label: 'Normal (50x)', val: 50 },
                  { label: 'Fast (100x)', val: 100 },
                  { label: 'Warp (250x)', val: 250 },
                  { label: 'Extreme (500x)', val: 500 }
                ].map((s) => (
                  <button
                    key={s.val}
                    type="button"
                    onClick={() => setExportSpeed(s.val)}
                    className={`py-2 px-2 text-center rounded-xl text-xs font-bold border transition-all ${
                      exportSpeed === s.val 
                        ? 'bg-[#FC5200] border-[#FC5200] text-white shadow-sm' 
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-500">Higher speed settings create shorter, snappier TikTok loops.</p>
            </div>

            {/* Video View Style Choice */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-zinc-400 block uppercase">Visual Background Style</label>
              <div className="grid grid-cols-1 gap-2">
                {[
                  { id: 'realistic', label: 'Realistic 2D (Map Tile Backdrop)' },
                  { id: 'minimalist', label: 'Dark Grid 2D (Minimalist Backdrop)' },
                  { id: '3d', label: '3D Orbit Camera (Simulated Flight)' }
                ].map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    onClick={() => setExportStyle(style.id)}
                    className={`p-3 text-left rounded-xl text-xs font-bold border transition-all flex justify-between items-center ${
                      exportStyle === style.id 
                        ? 'bg-[#FC5200]/10 border-[#FC5200] text-[#FC5200]' 
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    <span>{style.label}</span>
                    <span className="w-2 h-2 rounded-full bg-current" style={{ opacity: exportStyle === style.id ? 1 : 0 }} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowExportModal(false)}
                className="flex-1 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 text-xs font-bold transition-all"
              >
                Cancel
              </button>
              <button
                onClick={startRecording}
                className="flex-1 py-2.5 rounded-xl bg-[#FC5200] hover:bg-[#e04600] text-white text-xs font-bold transition-all"
              >
                Render & Export
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-zinc-900 mt-12 bg-zinc-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-semibold text-zinc-500">
          <div className="flex items-center gap-1.5">
            <Route className="w-4 h-4 text-zinc-700" />
            <span>gpx.run · Route telemetry player</span>
          </div>
          <div>
            <span>Made by 0xs4b</span>
          </div>
        </div>
      </footer>
    </div>
  )
}