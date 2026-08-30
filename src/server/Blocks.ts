/**
 * How closely one train may follow another.
 *
 * Trains are spaced by block: the line is divided into sections and a
 * following train may not enter one still occupied. So a train catching up to
 * a slower one ahead does not close the gap and sit behind it — it is stopped
 * or slowed a block short, and that is what a position estimate ignoring the
 * traffic gets wrong. It happens routinely on a busy two-track stretch like
 * Bordeaux–Dax.
 *
 * The honest limit of this: SNCF does not publish where the signals are. The
 * dataset named "images des feux de circulation ferroviaire" is a
 * computer-vision corpus — bounding boxes in camera frames, no coordinates —
 * so individual signals, and the franchissable / non-franchissable distinction
 * between them, cannot be modelled. What is published is the *mode* of block
 * working per line section, and that fixes the scale of the spacing, which is
 * what a position estimate actually needs.
 *
 * The distances below are the usual design figures for each mode, not
 * measurements of any particular line.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Fallback where the mode is unknown: a typical BAL block. */
const DEFAULT_BLOCK_M = 1800;

/**
 * Typical block length by working mode, in metres.
 *
 * Matched on a distinctive fragment of the label, lower-cased, because the
 * published wording carries qualifiers ("de voie unique", "de voie banalisée")
 * that do not change the spacing.
 */
const BLOCK_BY_MODE: ReadonlyArray<readonly [string, number]> = [
  // Cab signalling on the LGVs: short blocks, trains three minutes apart.
  ['transmission voie-machine', 1500],
  ['european train control system', 1500],
  // The common lit automatic block.
  ['block automatique lumineux', 1800],
  // Reduced-permissivity automatic block: far longer sections, on single
  // track or quieter routes.
  ['block automatique à permissivité restreinte', 8000],
  ['block automatique a permissivite restreinte', 8000],
  // Manual and telephone block: one train per section, and the sections are
  // whole inter-station distances.
  ['block manuel', 15000],
  ['cantonnement téléphonique', 20000],
  ['cantonnement telephonique', 20000],
  // Nothing to enforce; treat as unconstrained rather than pretending.
  ['sans cantonnement', 0],
];

interface CantonRow {
  code_ligne?: string;
  libelle?: string;
  pkd?: string;
  pkf?: string;
  /** Midpoint of the section, published for every row. */
  geo_point_2d?: { lat: number; lon: number };
}

/** Grid cell size for the geographic lookup, in degrees — roughly 11 km. */
const CELL = 0.1;

/** "016+953" → 16.953 km. Shared shape with the speed table's PKs. */
function parsePk(pk: string | undefined): number | null {
  if (!pk) return null;
  const m = /^(\d+)\+(\d+)$/.exec(pk.trim());
  if (!m) {
    const n = Number(pk);
    return Number.isFinite(n) ? n : null;
  }
  return Number(m[1]) + Number(m[2]) / 1000;
}

/** Metres of block for a mode label, or null when it is not one we know. */
export function blockLengthFor(label: string | undefined): number | null {
  if (!label) return null;
  const l = label.toLowerCase();
  for (const [needle, metres] of BLOCK_BY_MODE) {
    if (l.includes(needle)) return metres;
  }
  return null;
}

export class BlockIndex {
  private readonly byLine = new Map<string, Array<{ from: number; to: number; m: number }>>();
  /**
   * Sections by grid cell, for looking spacing up from a position.
   *
   * The line code in this dataset is the infrastructure one, and a train
   * carries a commercial line label — the two do not join. Position is the
   * only key both sides actually share.
   */
  private readonly cells = new Map<string, Array<{ lat: number; lon: number; m: number }>>();

  constructor(rows: readonly CantonRow[]) {
    for (const r of rows) {
      const code = r.code_ligne;
      const metres = blockLengthFor(r.libelle);
      if (metres === null) continue;

      const pt = r.geo_point_2d;
      if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon)) {
        const key = `${Math.floor(pt.lat / CELL)},${Math.floor(pt.lon / CELL)}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push({ lat: pt.lat, lon: pt.lon, m: metres });
        else this.cells.set(key, [{ lat: pt.lat, lon: pt.lon, m: metres }]);
      }

      if (!code) continue;

      const a = parsePk(r.pkd);
      const b = parsePk(r.pkf);
      let arr = this.byLine.get(code);
      if (!arr) {
        arr = [];
        this.byLine.set(code, arr);
      }
      arr.push({
        from: Math.min(a ?? -1e9, b ?? 1e9),
        to: Math.max(a ?? -1e9, b ?? 1e9),
        m: metres,
      });
    }
  }

  get lines(): number {
    return this.byLine.size;
  }

  /**
   * Minimum spacing on a section, in metres.
   *
   * The longest block overlapping the span, because that is the binding
   * constraint: a train must clear the whole section it is in.
   */
  spacingFor(code: string | undefined, pkA: number | null, pkB: number | null): number {
    const arr = code ? this.byLine.get(code) : undefined;
    if (!arr?.length) return DEFAULT_BLOCK_M;

    if (pkA == null || pkB == null) {
      return Math.max(...arr.map((x) => x.m));
    }
    const lo = Math.min(pkA, pkB);
    const hi = Math.max(pkA, pkB);

    let worst = 0;
    let hit = false;
    for (const x of arr) {
      if (x.to < lo || x.from > hi) continue;
      hit = true;
      if (x.m > worst) worst = x.m;
    }
    return hit ? worst : DEFAULT_BLOCK_M;
  }

  /**
   * Spacing near a point, in metres.
   *
   * Searches outward by cell ring until something is found, so a train over a
   * section whose midpoint sits in a neighbouring cell still gets an answer.
   * Falls back to a typical lit block where nothing is near.
   */
  spacingNear(lat: number, lon: number): number {
    const ci = Math.floor(lat / CELL);
    const cj = Math.floor(lon / CELL);

    for (let r = 0; r <= 3; r++) {
      let best: number | null = null;
      let bestD = Infinity;
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          // Only the new ring each time round.
          if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
          for (const s of this.cells.get(`${i},${j}`) ?? []) {
            const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2;
            if (d < bestD) {
              bestD = d;
              best = s.m;
            }
          }
        }
      }
      if (best !== null) return best;
    }
    return DEFAULT_BLOCK_M;
  }

  get sections(): number {
    let n = 0;
    for (const b of this.cells.values()) n += b.length;
    return n;
  }

  /** Load from data/geo, or null when the file has not been fetched. */
  static async load(dataDir = 'data'): Promise<BlockIndex | null> {
    const file = path.join(dataDir, 'geo', 'cantonnement.json');
    if (!existsSync(file)) return null;
    try {
      return new BlockIndex(JSON.parse(await readFile(file, 'utf8')) as CantonRow[]);
    } catch {
      // Spacing is a refinement, not a requirement.
      return null;
    }
  }
}
