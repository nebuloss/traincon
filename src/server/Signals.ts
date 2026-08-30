/**
 * Where the signals are, and which of them can stop a train.
 *
 * 24 673 stop signals covering the whole national network, from the
 * signalling layer published by Carto Tchoo — see data/geo/README.md for the
 * provenance and why the alternatives were not usable.
 *
 * The published file carries only what is read here. The tile export it comes
 * from holds 116 818 objects of every kind; four fifths of them are whistle
 * boards, speed boards and the like, which this needs for exactly one thing —
 * the name of the track they stand on — so that is folded into a set per grid
 * cell when the file is made. See tools/pack-signals.mjs.
 *
 * The two that matter for spacing:
 *
 *   CARRE  non franchissable — an absolute stop. A train may not pass it.
 *   S      sémaphore, franchissable — stop, then proceed at caution.
 *
 * Both stop a train, which is what a braking curve needs; the difference is
 * what happens afterwards, and that is beyond what can be inferred without
 * live aspects. The rest of the layer is speed boards, whistle boards, and
 * markers that do not constrain spacing.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Signals that can bring a train to a stand. */
const STOP_TYPES = new Set(['CARRE', 'S']);

/** Grid cell, degrees — about 5.5 km, so a lookup touches few candidates. */
const CELL = 0.05;

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

export interface Signal {
  lat: number;
  lon: number;
  /** CARRE or S. */
  type: string;
  /** Infrastructure line code, so signals can be kept to the train's own line. */
  line: string | null;
  /** Track this stands on: V1, V2, UNIQUE for single track, or a yard name. */
  voie?: string | null;
}

/** How many tracks there are at a point, and whether it is single. */
export interface TrackLayout {
  /**
   * Single track — trains in opposite directions cannot pass, so they
   * constrain each other absolutely rather than only when following.
   */
  single: boolean;
  /** Distinct tracks seen nearby. */
  tracks: number;
}

export interface SignalAhead {
  signal: Signal;
  distanceM: number;
}

/**
 * The published form, written by tools/pack-signals.mjs.
 *
 * Only the stop signals are carried whole. Everything else in the tile export
 * contributes one thing — the name of the track it stands on — and that is
 * folded into `tracks` when the file is made rather than at every boot. It is
 * a fifth of the objects and an eighth of the bytes.
 */
interface PackedSignals {
  format: number;
  /**
   * The cell size the track sets were folded at. Written down because a
   * reader using a different one would bucket them wrongly and quietly report
   * the wrong number of tracks.
   */
  cell: number;
  count: number;
  /** Degrees times 1e5 — about a metre, far finer than the model asks. */
  lat: number[];
  lon: number[];
  /** 1 for a carré, which may not be passed; 0 for a sémaphore, which may. */
  carre: (0 | 1)[];
  lines: string[];
  /** Index into `lines`, or -1 where the line is not known. */
  line: number[];
  tracks: [string, string[]][];
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingTo(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLon = (bLon - aLon) * RAD;
  const y = Math.sin(dLon) * Math.cos(bLat * RAD);
  const x =
    Math.cos(aLat * RAD) * Math.sin(bLat * RAD) -
    Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Smallest angle between two headings, degrees. */
function headingGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export class SignalIndex {
  private readonly cells = new Map<string, Signal[]>();
  /**
   * Track names seen in each cell, from *every* object rather than only the
   * stop signals — a stretch of plain single track carries whistle boards and
   * speed boards but few carrés, and dropping those would make it look
   * double-tracked.
   *
   * Stored as names per cell rather than per object: a few tens of thousands
   * of small sets instead of a record for each of 116 000 objects.
   */
  private readonly tracks = new Map<string, Set<string>>();

  constructor(signals: readonly Signal[]) {
    for (const s of signals) {
      const key = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`;

      if (s.voie) {
        const seen = this.tracks.get(key);
        if (seen) seen.add(s.voie);
        else this.tracks.set(key, new Set([s.voie]));
      }

      if (!STOP_TYPES.has(s.type)) continue;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(s);
      else this.cells.set(key, [s]);
    }
  }

  /**
   * The track layout around a point.
   *
   * `UNIQUE` is published explicitly for single track, which is better than
   * inferring it from a count: a quiet double-track section might carry only
   * one signal in a cell and look single by accident.
   *
   * Yard and platform names (A, B, 3, 4…) are counted but do not make a line
   * "not single": a passing loop at a station on a single-track line is still
   * a single-track line either side of it.
   */
  tracksNear(lat: number, lon: number): TrackLayout {
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);

    const seen = new Set<string>();
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const v of this.tracks.get(`${i},${j}`) ?? []) seen.add(v);
      }
    }

    if (!seen.size) return { single: false, tracks: 0 };

    const running = [...seen].filter((v) => /^V?\d+(BIS|TER)?$/i.test(v) || v === 'UNIQUE');
    return {
      single: seen.has('UNIQUE') && !seen.has('V2'),
      tracks: running.length || seen.size,
    };
  }

  get size(): number {
    let n = 0;
    for (const b of this.cells.values()) n += b.length;
    return n;
  }

  /**
   * The next stop signal a train is running towards.
   *
   * "Ahead" means within 60° of the direction of travel, judged from the
   * bearing to the signal — enough to exclude the one just passed, which is
   * behind by definition, without needing to know which track the train is on.
   *
   * Signals face a direction, and the layer records that, but a train's track
   * is not known well enough to use it: the position is an estimate projected
   * onto a line, and stations have several parallel tracks a few metres apart.
   * So this reports the nearest stop signal ahead on the same line and leaves
   * the caller to treat it as approximate.
   */
  nextAhead(lat: number, lon: number, bearing: number, maxKm = 8, line?: string | null): SignalAhead | null {
    const rings = Math.ceil(maxKm / (CELL * 111)) + 1;
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);

    let best: SignalAhead | null = null;

    for (let i = ci - rings; i <= ci + rings; i++) {
      for (let j = cj - rings; j <= cj + rings; j++) {
        const bucket = this.cells.get(`${i},${j}`);
        if (!bucket) continue;
        for (const s of bucket) {
          if (line && s.line && s.line !== line) continue;

          const km = haversineKm(lat, lon, s.lat, s.lon);
          if (km > maxKm) continue;
          // Too close to tell ahead from behind; treat as already passed.
          if (km < 0.02) continue;
          if (headingGap(bearing, bearingTo(lat, lon, s.lat, s.lon)) > 60) continue;

          if (!best || km * 1000 < best.distanceM) {
            best = { signal: s, distanceM: Math.round(km * 1000) };
          }
        }
      }
    }
    return best;
  }

  /**
   * Infrastructure line code at a point, from the nearest signal.
   *
   * Trains carry a *commercial* line label — "Paris - Rennes - Saint-Malo
   * TGV" — and two trains sharing a physical route routinely carry different
   * ones, so grouping by it finds almost no pairs. The infrastructure code is
   * the same for both because it describes the track, not the service.
   */
  lineAt(lat: number, lon: number, maxKm = 2): string | null {
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);
    const rings = Math.ceil(maxKm / (CELL * 111)) + 1;

    let best: string | null = null;
    let bestKm = Infinity;
    for (let i = ci - rings; i <= ci + rings; i++) {
      for (let j = cj - rings; j <= cj + rings; j++) {
        for (const s of this.cells.get(`${i},${j}`) ?? []) {
          if (!s.line) continue;
          const km = haversineKm(lat, lon, s.lat, s.lon);
          if (km < bestKm && km <= maxKm) {
            bestKm = km;
            best = s.line;
          }
        }
      }
    }
    return best;
  }

  /** Rebuild from the published columns. */
  private static fromPacked(p: PackedSignals): SignalIndex | null {
    if (p.cell !== CELL) {
      // Refusing is better than answering wrongly: the track sets were folded
      // at the file's cell size, and reading them at another one would put
      // them in the wrong buckets.
      console.warn(`signals: packed at cell ${p.cell}, this build uses ${CELL}`);
      return null;
    }

    const signals: Signal[] = [];
    for (let i = 0; i < p.count; i++) {
      const li = p.line[i] ?? -1;
      signals.push({
        lat: p.lat[i]! / 1e5,
        lon: p.lon[i]! / 1e5,
        type: p.carre[i] ? 'CARRE' : 'S',
        line: li >= 0 ? (p.lines[li] ?? null) : null,
      });
    }

    const index = new SignalIndex(signals);
    for (const [key, names] of p.tracks) index.tracks.set(key, new Set(names));
    return index;
  }

  /** Load from data/geo, or null when the file has not been fetched. */
  static async load(dataDir = 'data'): Promise<SignalIndex | null> {
    const file = path.join(dataDir, 'geo', 'signals.json');
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<PackedSignals> & {
        rows?: Signal[];
      };
      if (raw.format === 2) return SignalIndex.fromPacked(raw as PackedSignals);
      // The raw tile export, as published before the file was packed down. An
      // installation that has not fetched again since still has one of these.
      if (raw.rows?.length) return new SignalIndex(raw.rows);
      return null;
    } catch {
      // Signalling is a refinement, not a requirement.
      return null;
    }
  }
}
