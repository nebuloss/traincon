/**
 * Rail graph over the French national network (RFN).
 *
 * Source: SNCF Réseau "formes-des-lignes-du-rfn" (1638 LineStrings, ~235k
 * points) plus "vitesse-maximale-nominale-sur-ligne" for line speeds.
 *
 * Gives a track-following polyline between two stations, so a train can be
 * projected onto the rails rather than a straight line, with a tangent bearing
 * that follows real curves and a speed profile taken from the line limits.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MinHeap } from './MinHeap.ts';
import { bearing, haversineRaw, type LatLon } from './geo.ts';

/** ~11 m at French latitudes: welds adjacent track vertices into shared nodes. */
const SNAP = 1e-4;
/** Spatial bucket for nearest-node lookup, ~5 km. */
const CELL = 0.05;

/**
 * Only track that actually carries trains. The RFN export also ships closed,
 * neutralised, downgraded and sold-off lines; routing over those puts trains on
 * track that has not seen a service in decades.
 */
export const IN_SERVICE = 'EXPLOITE';

interface RfnProps {
  code_ligne?: string;
  mnemo?: string;
  pk_debut_r?: string;
  pk_fin_r?: string;
}
interface RfnFeature {
  geometry: { type: string; coordinates: number[][] | number[][][] } | null;
  properties?: RfnProps;
}
interface RfnGeoJson {
  features: RfnFeature[];
}

export interface SpeedRow {
  code_ligne?: string;
  v_max?: string;
  pkd?: string;
  pkf?: string;
}

/** A routed path between two points, with distance and time profiles. */
export interface RailPath {
  /** [lat, lon] vertices. */
  pts: Array<[number, number]>;
  /** Cumulative distance at each vertex, km. */
  cum: number[];
  /** Cumulative nominal traversal time at each vertex, hours. */
  cumT: number[];
  /** Line speed of each segment, km/h. */
  segV: number[];
  /** Total track distance, km. */
  total: number;
  /** Straight-line distance, km, for sanity checks. */
  direct: number;
}

export interface PathPoint extends LatLon {
  bearing: number;
  /** Distance travelled along the path, km. */
  distKm: number;
  segIndex: number;
  /** Permitted line speed here, km/h. */
  lineKmh: number | null;
  /** Nominal time for the whole path at line speed, hours. */
  nominalHours: number | null;
}

const isInService = (p: RfnProps | undefined): boolean => p?.mnemo === IN_SERVICE;

/** "629+739" -> 629.739 km */
function parsePk(v: string | undefined): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(-?\d+)\s*\+\s*(\d+)$/.exec(v.trim());
  if (m) return Number(m[1]) + Number(m[2]) / 1000;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Ramer-Douglas-Peucker in degrees. Thins geometry for display only — the
 * routing graph always keeps full precision.
 */
export function simplify(points: number[][], tol: number): number[][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let best = -1;
    let bestD = 0;
    const [x1, y1] = points[lo] as [number, number];
    const [x2, y2] = points[hi] as [number, number];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const den = dx * dx + dy * dy;
    for (let i = lo + 1; i < hi; i++) {
      const [x, y] = points[i] as [number, number];
      let d: number;
      if (den === 0) d = Math.hypot(x - x1, y - y1);
      else {
        let t = ((x - x1) * dx + (y - y1) * dy) / den;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > tol && best !== -1) {
      keep[best] = 1;
      stack.push([lo, best], [best, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Line speeds indexed by line code with their PK ranges, so a track section
 * can be given its real design speed.
 */
export class SpeedIndex {
  private readonly byLine = new Map<string, Array<{ from: number; to: number; v: number }>>();

  constructor(rows: SpeedRow[]) {
    for (const r of rows) {
      const code = r.code_ligne;
      const v = Number(r.v_max);
      if (!code || !Number.isFinite(v) || v <= 0) continue;
      const a = parsePk(r.pkd);
      const b = parsePk(r.pkf);
      let arr = this.byLine.get(code);
      if (!arr) {
        arr = [];
        this.byLine.set(code, arr);
      }
      arr.push({ from: Math.min(a ?? -1e9, b ?? 1e9), to: Math.max(a ?? -1e9, b ?? 1e9), v });
    }
  }

  /** Representative speed for a track section, by line code and PK span. */
  speedFor(code: string | undefined, pkA: number | null, pkB: number | null, fallback = 100): number {
    const arr = code ? this.byLine.get(code) : undefined;
    if (!arr?.length) return fallback;
    if (pkA == null || pkB == null) return Math.max(...arr.map((x) => x.v));
    const lo = Math.min(pkA, pkB);
    const hi = Math.max(pkA, pkB);
    let best = 0;
    let hit = false;
    for (const x of arr) {
      if (x.to < lo || x.from > hi) continue;
      hit = true;
      if (x.v > best) best = x.v;
    }
    return hit ? best : Math.max(...arr.map((x) => x.v));
  }
}

/**
 * A train leaves and enters a station at rest, so the first and last kilometres
 * are covered far slower than the line speed. v = sqrt(2·a·x) with a gentle
 * 0.4 m/s² captures that without pretending to model traction.
 */
const ACCEL_MS2 = 0.4;
function rampedSpeed(vKmh: number, distFromStopKm: number): number {
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
function nominalTimeProfile(cum: number[], segV: number[], total: number): number[] {
  const out = [0];
  for (let i = 1; i < cum.length; i++) {
    const d = cum[i]! - cum[i - 1]!;
    const mid = (cum[i]! + cum[i - 1]!) / 2;
    const vLine = segV[i - 1] ?? segV[segV.length - 1] ?? 100;
    const v = rampedSpeed(vLine, Math.min(mid, total - mid));
    out.push(out[i - 1]! + (v > 0 ? d / v : 0));
  }
  return out;
}

export class RailGraph {
  private readonly lat: number[] = [];
  private readonly lon: number[] = [];
  /** Flattened triples: [nodeId, distKm, hours, …] */
  private readonly adj: number[][] = [];
  /**
   * Drop the least recently used paths until the cache is within budget.
   *
   * Map preserves insertion order and a hit re-inserts, so the first key is
   * always the coldest.
   */
  private evict(): void {
    while (
      this.cachedPoints > this.pathPointBudget ||
      this.pathCache.size > RailGraph.PATH_CACHE_MAX
    ) {
      const oldest = this.pathCache.keys().next().value;
      if (oldest === undefined) break;
      this.cachedPoints -= this.pathCache.get(oldest)?.pts.length ?? 0;
      this.pathCache.delete(oldest);
    }
    // A negative count would mean the bookkeeping had drifted; clamp rather
    // than let it disable the budget silently.
    if (this.cachedPoints < 0) this.cachedPoints = 0;
  }

  /** What the path cache is holding, for the memory diagnostics. */
  get cacheStats(): { paths: number; points: number } {
    return { paths: this.pathCache.size, points: this.cachedPoints };
  }

  private readonly index = new Map<string, number>();
  private readonly cells = new Map<string, number[]>();
  /**
   * Routed paths, bounded.
   *
   * Each entry holds up to a few thousand coordinate pairs plus three parallel
   * arrays, and a day's worth of legs is ~8000 of them — 80 MB that never came
   * back, which is what eventually exhausted the heap on a 512 MB container.
   * A Map preserves insertion order, so dropping its oldest keys approximates
   * least-recently-added; a cache hit re-inserts, keeping hot paths resident.
   */
  private readonly pathCache = new Map<string, RailPath | null>();
  /**
   * What the path cache may hold, counted in vertices rather than paths.
   *
   * It used to cap the number of paths, at 2 500. That is the wrong unit: a
   * suburban hop is a few dozen vertices and Bordeaux–Paris is thousands, so
   * the same cap could mean 5 MB or 150 MB depending on which trains happened
   * to run. Measured at 573 vertices per path, 2 500 paths is ~1.4 million
   * vertices — about 110 MB against a 281 MB ceiling, in one structure. That
   * is what exhausted the heap.
   *
   * Each vertex costs roughly 80 bytes: a two-element array for [lat, lon]
   * plus one double each in cum, cumT and segV. 400 000 is therefore ~32 MB.
   */
  private readonly pathPointBudget = Number(process.env['RAIL_PATH_POINTS'] ?? 400_000);
  /** Secondary guard, for a run of unusually short paths. */
  private static readonly PATH_CACHE_MAX = 4000;
  /**
   * Vertices currently held by the cache.
   *
   * The cap is a count of paths, but the cost of a path is its length, and
   * those differ by orders of magnitude: a suburban hop is a handful of
   * vertices, Bordeaux–Paris is thousands. Tracked incrementally so the real
   * figure is available without walking the cache.
   */
  private cachedPoints = 0;

  /** Thinned in-service network for drawing; built alongside the graph. */
  display: { type: 'FeatureCollection'; features: unknown[] } | null = null;

  get nodeCount(): number {
    return this.lat.length;
  }

  private keyOf(lat: number, lon: number): string {
    return `${Math.round(lat / SNAP)},${Math.round(lon / SNAP)}`;
  }
  private cellOf(lat: number, lon: number): string {
    return `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
  }

  private nodeAt(lat: number, lon: number): number {
    const k = this.keyOf(lat, lon);
    const existing = this.index.get(k);
    if (existing !== undefined) return existing;
    const id = this.lat.length;
    this.lat.push(lat);
    this.lon.push(lon);
    this.adj.push([]);
    this.index.set(k, id);
    const c = this.cellOf(lat, lon);
    let bucket = this.cells.get(c);
    if (!bucket) {
      bucket = [];
      this.cells.set(c, bucket);
    }
    bucket.push(id);
    return id;
  }

  private link(a: number, b: number, speedKmh = 100): void {
    if (a === b) return;
    const d = haversineRaw(this.lat[a]!, this.lon[a]!, this.lat[b]!, this.lon[b]!);
    if (!(d > 0)) return;
    const hours = d / Math.max(30, speedKmh);
    this.adj[a]!.push(b, d, hours);
    this.adj[b]!.push(a, d, hours);
  }

  /**
   * Weld gaps between separate LineStrings.
   *
   * The RFN export ships each line section as its own feature, and adjacent
   * sections rarely share an exact vertex. Without this the graph is a pile of
   * disconnected fragments and obvious routes (Mulhouse -> Colmar) fail. Only
   * dangling ends are considered, so we never invent a junction mid-line.
   */
  private stitch(toleranceKm = 0.12): number {
    const ends: number[] = [];
    for (let i = 0; i < this.adj.length; i++) {
      if (this.adj[i]!.length / 3 <= 1) ends.push(i);
    }
    let welded = 0;
    for (const id of ends) {
      if (this.adj[id]!.length / 3 > 1) continue;
      const lat = this.lat[id]!;
      const lon = this.lon[id]!;
      const ci = Math.floor(lat / CELL);
      const cj = Math.floor(lon / CELL);
      let best = -1;
      let bestD = Infinity;
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const bucket = this.cells.get(`${i},${j}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === id) continue;
            const a = this.adj[id]!;
            let adjacent = false;
            for (let k = 0; k < a.length; k += 3) {
              if (a[k] === other) {
                adjacent = true;
                break;
              }
            }
            if (adjacent) continue;
            const d = haversineRaw(lat, lon, this.lat[other]!, this.lon[other]!);
            if (d < bestD) {
              bestD = d;
              best = other;
            }
          }
        }
      }
      if (best !== -1 && bestD <= toleranceKm) {
        this.link(id, best, 60);
        welded++;
      }
    }
    return welded;
  }

  /**
   * Build from the RFN GeoJSON, weighting each section by its line speed so
   * routing prefers the route a train would actually take — without this a TGV
   * Paris->Bordeaux is routed down classic lines because they are shorter.
   */
  static fromGeoJson(geo: RfnGeoJson, speeds: SpeedIndex | null = null): RailGraph {
    const g = new RailGraph();
    for (const f of geo.features) {
      const geom = f.geometry;
      if (!geom) continue;
      const p = f.properties;
      if (!isInService(p)) continue;
      const v = speeds
        ? speeds.speedFor(p?.code_ligne, parsePk(p?.pk_debut_r), parsePk(p?.pk_fin_r))
        : 100;
      const lines =
        geom.type === 'LineString'
          ? [geom.coordinates as number[][]]
          : (geom.coordinates as number[][][]);
      for (const line of lines) {
        let prev = -1;
        for (const c of line) {
          const id = g.nodeAt(c[1]!, c[0]!);
          if (prev !== -1) g.link(prev, id, v);
          prev = id;
        }
      }
    }
    g.stitch();
    return g;
  }

  /** Nearest graph node to a point, searching outward by cell ring. */
  nearest(lat: number, lon: number, maxKm = 5): { id: number; distKm: number } | null {
    let best = -1;
    let bestD = Infinity;
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);
    const rings = Math.max(1, Math.ceil(maxKm / 5) + 1);
    for (let r = 0; r <= rings; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
          const bucket = this.cells.get(`${i},${j}`);
          if (!bucket) continue;
          for (const id of bucket) {
            const d = haversineRaw(lat, lon, this.lat[id]!, this.lon[id]!);
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
        }
      }
      if (best !== -1 && bestD <= (r + 1) * CELL * 111) break;
    }
    return bestD <= maxKm ? { id: best, distKm: bestD } : null;
  }

  /**
   * Fastest path (least travel time over line speeds), as node ids.
   * Minimising time rather than distance is what puts a TGV on the LGV.
   */
  route(from: number, to: number, maxHours = 14): number[] | null {
    if (from === to) return [from];
    const dist = new Float64Array(this.lat.length).fill(Infinity);
    const prev = new Int32Array(this.lat.length).fill(-1);
    const done = new Uint8Array(this.lat.length);
    dist[from] = 0;
    const h = new MinHeap<number>();
    h.push(0, from);
    while (h.size) {
      const top = h.pop()!;
      const [d, u] = top;
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      if (d > maxHours) return null;
      const a = this.adj[u]!;
      for (let i = 0; i < a.length; i += 3) {
        const v = a[i]!;
        const w = a[i + 2]!;
        const nd = d + w;
        if (nd < dist[v]!) {
          dist[v] = nd;
          prev[v] = u;
          h.push(nd, v);
        }
      }
    }
    if (!Number.isFinite(dist[to]!)) return null;
    const out: number[] = [];
    for (let n = to; n !== -1; n = prev[n]!) out.push(n);
    return out.reverse();
  }

  /**
   * Track-following polyline between two coordinates, with cumulative distance
   * and time so a position can be looked up by elapsed fraction.
   */
  path(aLat: number, aLon: number, bLat: number, bLon: number): RailPath | null {
    const ck = `${aLat.toFixed(4)},${aLon.toFixed(4)}|${bLat.toFixed(4)},${bLon.toFixed(4)}`;
    const hit = this.pathCache.get(ck);
    if (hit !== undefined) {
      // Re-insert so frequently used legs survive eviction. The point count is
      // unchanged: the same entry goes back in.
      this.pathCache.delete(ck);
      this.pathCache.set(ck, hit);
      return hit;
    }

    const A = this.nearest(aLat, aLon);
    const B = this.nearest(bLat, bLon);
    let result: RailPath | null = null;

    if (A && B) {
      const ids = this.route(A.id, B.id);
      if (ids) {
        const pts: Array<[number, number]> = ids.map((i) => [this.lat[i]!, this.lon[i]!]);
        // Line speed of each routed segment, recovered from the graph edges.
        const segV: number[] = [];
        for (let i = 1; i < ids.length; i++) {
          const a = this.adj[ids[i - 1]!]!;
          let v = 100;
          for (let k = 0; k < a.length; k += 3) {
            if (a[k] === ids[i]) {
              v = Math.round(a[k + 1]! / a[k + 2]!);
              break;
            }
          }
          segV.push(v);
        }
        // Anchor the ends on the true station coordinates; the stub segments
        // inherit the speed of the section they join.
        pts.unshift([aLat, aLon]);
        pts.push([bLat, bLon]);
        segV.unshift(segV[0] ?? 100);
        segV.push(segV[segV.length - 1] ?? 100);

        const cum = [0];
        for (let i = 1; i < pts.length; i++) {
          cum.push(cum[i - 1]! + haversineRaw(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]));
        }
        const total = cum[cum.length - 1]!;
        const direct = haversineRaw(aLat, aLon, bLat, bLon);
        // Reject nonsense detours (a disconnected network sending us round France).
        const slack = direct < 15 ? 3.2 : direct < 60 ? 2.2 : 1.8;
        result =
          total <= Math.max(12, direct * slack)
            ? { pts, cum, segV, total, direct, cumT: nominalTimeProfile(cum, segV, total) }
            : null;
      }
    }
    this.pathCache.set(ck, result);
    this.cachedPoints += result?.pts.length ?? 0;
    this.evict();
    return result;
  }

  /**
   * Point and tangent bearing at a fraction of the way along a path.
   *
   * `f` is a fraction of *time*, not distance. With a speed profile the two
   * differ sharply: on a Bordeaux–Paris leg the train spends a small share of
   * its time on the 160 km/h approach and most of it on the 320 km/h LGV, so
   * interpolating by distance puts it tens of kilometres off.
   */
  static at(p: RailPath, f: number): PathPoint {
    const frac = Math.max(0, Math.min(1, f));
    let target: number;

    if (p.cumT.length === p.cum.length) {
      const tTotal = p.cumT[p.cumT.length - 1]!;
      const tTarget = frac * tTotal;
      let j = 1;
      while (j < p.cumT.length - 1 && p.cumT[j]! < tTarget) j++;
      const dt = p.cumT[j]! - p.cumT[j - 1]!;
      const within = dt > 0 ? (tTarget - p.cumT[j - 1]!) / dt : 0;
      target = p.cum[j - 1]! + (p.cum[j]! - p.cum[j - 1]!) * within;
    } else {
      target = frac * p.total;
    }

    let i = 1;
    while (i < p.cum.length - 1 && p.cum[i]! < target) i++;
    const segLen = p.cum[i]! - p.cum[i - 1]!;
    const t = segLen > 0 ? (target - p.cum[i - 1]!) / segLen : 0;
    const [la, lo] = p.pts[i - 1]!;
    const [lb, lb2] = p.pts[i]!;

    const vLine = p.segV[i - 1] ?? null;
    const lineKmh =
      vLine == null ? null : Math.round(rampedSpeed(vLine, Math.min(target, p.total - target)));

    return {
      lat: la + (lb - la) * t,
      lon: lo + (lb2 - lo) * t,
      bearing: bearing({ lat: la, lon: lo }, { lat: lb, lon: lb2 }),
      distKm: target,
      segIndex: i,
      lineKmh,
      nominalHours: p.cumT[p.cumT.length - 1] ?? null,
    };
  }

  /**
   * Thinned in-service network for drawing. ~0.0015 deg (~150 m) is invisible
   * at national zoom and cuts the payload by an order of magnitude.
   */
  static displayGeoJson(geo: RfnGeoJson, speeds: SpeedIndex | null = null, tol = 0.0015) {
    const features: unknown[] = [];
    for (const f of geo.features) {
      const p = f.properties;
      if (!isInService(p)) continue;
      const geom = f.geometry;
      if (!geom) continue;
      // Line speed is what separates LGV from classic track on the map.
      const v = speeds
        ? speeds.speedFor(p?.code_ligne, parsePk(p?.pk_debut_r), parsePk(p?.pk_fin_r), 0)
        : 0;
      const lines =
        geom.type === 'LineString'
          ? [geom.coordinates as number[][]]
          : (geom.coordinates as number[][][]);
      for (const line of lines) {
        const pts = simplify(line, tol);
        if (pts.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: pts.map((c) => [Math.round(c[0]! * 1e5) / 1e5, Math.round(c[1]! * 1e5) / 1e5]),
          },
          properties: { v, hs: v >= 250 ? 1 : 0 },
        });
      }
    }
    return { type: 'FeatureCollection' as const, features };
  }

  /** Load the graph, building it from GeoJSON on first use. */
  static async load(dataDir = 'data'): Promise<RailGraph> {
    const geoFile = path.join(dataDir, 'geo', 'rfn.geojson');
    const vmaxFile = path.join(dataDir, 'geo', 'vmax.json');
    if (!existsSync(geoFile)) throw new Error(`missing ${geoFile} — run npm run fetch:geo`);
    const geo = JSON.parse(await readFile(geoFile, 'utf8')) as RfnGeoJson;
    let speeds: SpeedIndex | null = null;
    if (existsSync(vmaxFile)) {
      try {
        speeds = new SpeedIndex(JSON.parse(await readFile(vmaxFile, 'utf8')) as SpeedRow[]);
      } catch {
        /* speeds are an optimisation, not a requirement */
      }
    }
    const graph = RailGraph.fromGeoJson(geo, speeds);
    graph.display = RailGraph.displayGeoJson(geo, speeds);
    return graph;
  }
}
