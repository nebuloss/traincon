// Rail graph over the French national network (RFN).
//
// Source: SNCF Réseau "formes-des-lignes-du-rfn" (1638 LineStrings, ~235k
// points) plus "vitesse-maximale-nominale-sur-ligne" for line speeds.
//
// What it gives us: a real track-following polyline between two stations, so a
// train's position can be projected onto the rails instead of a straight line —
// and a tangent bearing that follows real curves.
//
// Build once, cache to disk; routing is Dijkstra over ~235k nodes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function bearingOf(aLat, aLon, bLat, bLon) {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// ~11 m at French latitudes. Coarse enough to weld parallel/adjacent track
// vertices into shared nodes, fine enough not to short-circuit real geography.
const SNAP = 1e-4;
const keyOf = (lat, lon) =>
  `${Math.round(lat / SNAP)},${Math.round(lon / SNAP)}`;

// Spatial bucket for nearest-node lookup (~5 km cells).
const CELL = 0.05;
const cellOf = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;

/** Minimal binary heap for Dijkstra. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top;
  }
}

// Only track that actually carries trains. The RFN export also ships closed,
// neutralised, downgraded and sold-off lines; routing over those puts trains on
// track that has not seen a service in decades.
export const IN_SERVICE = 'EXPLOITE';
export const isInService = (props) => props?.mnemo === IN_SERVICE;

/**
 * Ramer-Douglas-Peucker in degrees. Used only to thin geometry for display —
 * the routing graph always keeps full precision.
 */
export function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let best = -1, bestD = 0;
    const [x1, y1] = points[lo], [x2, y2] = points[hi];
    const dx = x2 - x1, dy = y2 - y1;
    const den = dx * dx + dy * dy;
    for (let i = lo + 1; i < hi; i++) {
      const [x, y] = points[i];
      let d;
      if (den === 0) d = Math.hypot(x - x1, y - y1);
      else {
        let t = ((x - x1) * dx + (y - y1) * dy) / den;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > tol && best !== -1) {
      keep[best] = 1;
      stack.push([lo, best], [best, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** "629+739" -> 629.739 km */
function parsePk(v) {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d+)\s*\+\s*(\d+)$/.exec(v.trim());
  if (m) return Number(m[1]) + Number(m[2]) / 1000;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Line speeds from "vitesse-maximale-nominale-sur-ligne", indexed by line code
 * with their PK ranges, so a track section can be given its real design speed.
 */
export function buildSpeedIndex(rows) {
  const byLine = new Map();
  for (const r of rows) {
    const code = r.code_ligne, v = Number(r.v_max);
    if (!code || !Number.isFinite(v) || v <= 0) continue;
    const a = parsePk(r.pkd), b = parsePk(r.pkf);
    let arr = byLine.get(code);
    if (!arr) { arr = []; byLine.set(code, arr); }
    arr.push({ from: Math.min(a ?? -1e9, b ?? 1e9), to: Math.max(a ?? -1e9, b ?? 1e9), v });
  }
  return byLine;
}

/** Representative speed for a track section, by line code and PK span. */
function speedFor(index, code, pkA, pkB, fallback = 100) {
  const arr = index?.get(code);
  if (!arr?.length) return fallback;
  if (pkA == null || pkB == null) {
    return Math.max(...arr.map((x) => x.v));
  }
  const lo = Math.min(pkA, pkB), hi = Math.max(pkA, pkB);
  let best = 0, hit = false;
  for (const x of arr) {
    if (x.to < lo || x.from > hi) continue;   // no overlap
    hit = true;
    if (x.v > best) best = x.v;
  }
  return hit ? best : Math.max(...arr.map((x) => x.v));
}

export class RailGraph {
  constructor() {
    this.lat = [];        // node id -> lat
    this.lon = [];        // node id -> lon
    this.adj = [];        // node id -> [nodeId, distKm, hours, ...] flattened triples
    this.index = new Map(); // snap key -> node id
    this.cells = new Map(); // cell key -> [node ids]
    this.pathCache = new Map();
  }

  nodeAt(lat, lon) {
    const k = keyOf(lat, lon);
    let id = this.index.get(k);
    if (id !== undefined) return id;
    id = this.lat.length;
    this.lat.push(lat); this.lon.push(lon); this.adj.push([]);
    this.index.set(k, id);
    const c = cellOf(lat, lon);
    let bucket = this.cells.get(c);
    if (!bucket) { bucket = []; this.cells.set(c, bucket); }
    bucket.push(id);
    return id;
  }

  link(a, b, speedKmh = 100) {
    if (a === b) return;
    const d = haversine(this.lat[a], this.lon[a], this.lat[b], this.lon[b]);
    if (!(d > 0)) return;
    const hours = d / Math.max(30, speedKmh);
    this.adj[a].push(b, d, hours);
    this.adj[b].push(a, d, hours);
  }

  /**
   * Weld gaps between separate LineStrings.
   *
   * The RFN export ships each line section as its own feature, and adjacent
   * sections rarely share an exact vertex. Without this the graph is a pile of
   * disconnected fragments and obvious routes (Mulhouse -> Colmar) fail.
   * Only dangling ends (degree 1) are considered, so we never invent a
   * junction in the middle of a line.
   */
  stitch(toleranceKm = 0.12) {
    const deg = this.adj.map((a) => a.length / 3);
    const ends = [];
    for (let i = 0; i < deg.length; i++) if (deg[i] <= 1) ends.push(i);
    let welded = 0;
    for (const id of ends) {
      if (this.adj[id].length / 3 > 1) continue; // already fixed this pass
      const lat = this.lat[id], lon = this.lon[id];
      const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
      let best = -1, bestD = Infinity;
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const bucket = this.cells.get(`${i},${j}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === id) continue;
            const a = this.adj[id];
            let adjacent = false;
            for (let k = 0; k < a.length; k += 3) if (a[k] === other) { adjacent = true; break; }
            if (adjacent) continue;
            const d = haversine(lat, lon, this.lat[other], this.lon[other]);
            if (d < bestD) { bestD = d; best = other; }
          }
        }
      }
      if (best !== -1 && bestD <= toleranceKm) { this.link(id, best, 60); welded++; }
    }
    return welded;
  }

  /**
   * Build from the RFN GeoJSON, weighting each section by its line speed so
   * routing prefers the route a train would actually take -- without this a
   * TGV Paris->Bordeaux is routed down classic lines because they are shorter.
   */
  static fromGeoJson(geo, speedIndex = null, filter = isInService) {
    const g = new RailGraph();
    for (const f of geo.features) {
      const geom = f.geometry;
      if (!geom) continue;
      const p = f.properties ?? {};
      if (filter && !filter(p)) continue;
      const v = speedFor(speedIndex, p.code_ligne, parsePk(p.pk_debut_r), parsePk(p.pk_fin_r));
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        let prev = -1;
        for (const [lon, lat] of line) {
          const id = g.nodeAt(lat, lon);
          if (prev !== -1) g.link(prev, id, v);
          prev = id;
        }
      }
    }
    g.stitch();
    return g;
  }

  /** Nearest graph node to a point, searching outward by cell ring. */
  nearest(lat, lon, maxKm = 5) {
    let best = -1, bestD = Infinity;
    const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    const rings = Math.max(1, Math.ceil(maxKm / 5) + 1);
    for (let r = 0; r <= rings; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          // only the ring boundary after the first pass
          if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
          const bucket = this.cells.get(`${i},${j}`);
          if (!bucket) continue;
          for (const id of bucket) {
            const d = haversine(lat, lon, this.lat[id], this.lon[id]);
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
      if (best !== -1 && bestD <= (r + 1) * CELL * 111) break;
    }
    return bestD <= maxKm ? { id: best, distKm: bestD } : null;
  }

  /**
   * Fastest path (least travel time over line speeds), returns node ids.
   * Minimising time rather than distance is what puts a TGV on the LGV.
   */
  route(from, to, maxHours = 14) {
    if (from === to) return [from];
    const dist = new Float64Array(this.lat.length).fill(Infinity);
    const prev = new Int32Array(this.lat.length).fill(-1);
    const done = new Uint8Array(this.lat.length);
    dist[from] = 0;
    const h = new Heap();
    h.push([0, from]);
    while (h.size) {
      const [d, u] = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      if (d > maxHours) return null;
      const a = this.adj[u];
      for (let i = 0; i < a.length; i += 3) {
        const v = a[i], w = a[i + 2];
        const nd = d + w;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push([nd, v]); }
      }
    }
    if (!Number.isFinite(dist[to])) return null;
    const out = [];
    for (let n = to; n !== -1; n = prev[n]) out.push(n);
    return out.reverse();
  }

  /**
   * Track-following polyline between two coordinates, with cumulative
   * distances so a position can be looked up by distance travelled.
   */
  path(aLat, aLon, bLat, bLon) {
    const ck = `${aLat.toFixed(4)},${aLon.toFixed(4)}|${bLat.toFixed(4)},${bLon.toFixed(4)}`;
    const hit = this.pathCache.get(ck);
    if (hit !== undefined) return hit;

    const A = this.nearest(aLat, aLon), B = this.nearest(bLat, bLon);
    let result = null;
    if (A && B) {
      const ids = this.route(A.id, B.id);
      if (ids) {
        const pts = ids.map((i) => [this.lat[i], this.lon[i]]);
        // Line speed of each routed segment, recovered from the graph edges.
        const segV = [];
        for (let i = 1; i < ids.length; i++) {
          const a = this.adj[ids[i - 1]];
          let v = 100;
          for (let k = 0; k < a.length; k += 3) {
            if (a[k] === ids[i]) { v = Math.round(a[k + 1] / a[k + 2]); break; }  // km/h
          }
          segV.push(v);
        }
        // Anchor the ends on the true station coordinates; the stub segments
        // inherit the speed of the section they join.
        pts.unshift([aLat, aLon]); pts.push([bLat, bLon]);
        segV.unshift(segV[0] ?? 100); segV.push(segV[segV.length - 1] ?? 100);

        const cum = [0];
        for (let i = 1; i < pts.length; i++) {
          cum.push(cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
        }
        const total = cum[cum.length - 1];
        const direct = haversine(aLat, aLon, bLat, bLon);
        // Reject nonsense detours (disconnected network sending us round France).
        const slack = direct < 15 ? 3.2 : direct < 60 ? 2.2 : 1.8;
        result = total <= Math.max(12, direct * slack)
          ? { pts, cum, total, direct, segV, cumT: nominalTimeProfile(cum, segV, total) }
          : null;
      }
    }
    this.pathCache.set(ck, result);
    return result;
  }

  /**
   * Point + tangent bearing at a fraction of the way along a path.
   *
   * `f` is a fraction of *time*, not distance. With a speed profile the two
   * differ sharply: on a Bordeaux–Paris leg the train spends a small share of
   * its time on the 160 km/h approach and most of it on the 320 km/h LGV, so
   * interpolating by distance puts it tens of kilometres off.
   */
  static at(pathObj, f) {
    const { pts, cum, total, cumT } = pathObj;
    const frac = Math.max(0, Math.min(1, f));

    let target;
    if (cumT && cumT.length === cum.length) {
      // Walk the time profile, then read off the distance reached.
      const tTotal = cumT[cumT.length - 1];
      const tTarget = frac * tTotal;
      let j = 1;
      while (j < cumT.length - 1 && cumT[j] < tTarget) j++;
      const dt = cumT[j] - cumT[j - 1];
      const within = dt > 0 ? (tTarget - cumT[j - 1]) / dt : 0;
      target = cum[j - 1] + (cum[j] - cum[j - 1]) * within;
    } else {
      target = frac * total;
    }

    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const segLen = cum[i] - cum[i - 1];
    const t = segLen > 0 ? (target - cum[i - 1]) / segLen : 0;
    const [la, lo] = pts[i - 1], [lb, lb2] = [pts[i][0], pts[i][1]];
    // Line speed where the train actually is, tapered for the station ramps.
    const vLine = pathObj.segV?.[i - 1] ?? null;
    const lineKmh = vLine == null ? null
      : Math.round(rampedSpeed(vLine, Math.min(target, total - target)));

    return {
      lat: la + (lb - la) * t,
      lon: lo + (lb2 - lo) * t,
      bearing: bearingOf(la, lo, lb, lb2),
      distKm: target,
      segIndex: i,
      lineKmh,
      nominalHours: pathObj.cumT?.[pathObj.cumT.length - 1] ?? null,
    };
  }

  async saveCache(file) {
    await mkdir(path.dirname(file), { recursive: true });
    const entries = [...this.pathCache.entries()].filter(([, v]) => v);
    await writeFile(file, JSON.stringify(entries.map(([k, v]) => [k, v.pts, v.total])));
  }
}

// A train leaves and enters a station at rest, so the first and last
// kilometres are covered far slower than the line speed. v = sqrt(2·a·x)
// with a gentle 0.4 m/s² captures that without pretending to model traction.
const ACCEL_MS2 = 0.4;
function rampedSpeed(vKmh, distFromStopKm) {
  const x = Math.max(0, distFromStopKm) * 1000;
  const vRamp = Math.sqrt(2 * ACCEL_MS2 * x) * 3.6;
  return Math.max(8, Math.min(vKmh, vRamp || vKmh));
}

/**
 * Cumulative nominal traversal time (hours) along a path.
 *
 * Each segment is timed at its own line speed, tapered near both ends for
 * acceleration and braking. Absolute values do not matter — only the shape,
 * since the profile is scaled onto the timetable's actual leg duration.
 */
function nominalTimeProfile(cum, segV, total) {
  const out = [0];
  for (let i = 1; i < cum.length; i++) {
    const d = cum[i] - cum[i - 1];
    const mid = (cum[i] + cum[i - 1]) / 2;
    const vLine = segV[i - 1] ?? segV[segV.length - 1] ?? 100;
    const v = rampedSpeed(vLine, Math.min(mid, total - mid));
    out.push(out[i - 1] + (v > 0 ? d / v : 0));
  }
  return out;
}

/** Load the graph, building it from GeoJSON on first use. */
/**
 * Thinned in-service network for drawing. ~0.0015 deg (~150 m) is invisible at
 * national zoom and cuts the payload by an order of magnitude.
 */
export function displayGeoJson(geo, speedIndex = null, tol = 0.0015) {
  const features = [];
  for (const f of geo.features) {
    const p = f.properties ?? {};
    if (!isInService(p)) continue;
    const geom = f.geometry;
    if (!geom) continue;
    // Line speed is what separates LGV from classic track on the map.
    const v = speedFor(speedIndex, p.code_ligne, parsePk(p.pk_debut_r), parsePk(p.pk_fin_r), 0);
    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    for (const line of lines) {
      const pts = simplify(line, tol);
      if (pts.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: pts.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) },
        properties: { v, hs: v >= 250 ? 1 : 0 },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export async function loadRailGraph(dataDir = 'data') {
  const geoFile = path.join(dataDir, 'geo', 'rfn.geojson');
  const vmaxFile = path.join(dataDir, 'geo', 'vmax.json');
  if (!existsSync(geoFile)) throw new Error(`missing ${geoFile} — run npm run fetch:geo`);
  const geo = JSON.parse(await readFile(geoFile, 'utf8'));
  let speedIndex = null;
  if (existsSync(vmaxFile)) {
    try { speedIndex = buildSpeedIndex(JSON.parse(await readFile(vmaxFile, 'utf8'))); }
    catch { /* speeds are an optimisation, not a requirement */ }
  }
  const graph = RailGraph.fromGeoJson(geo, speedIndex);
  graph.display = displayGeoJson(geo, speedIndex);
  return graph;
}
