/**
 * Putting a train's route onto the rails it actually runs on.
 *
 * The route the server returns is a schematic centreline. It comes from the
 * national network graph, which carries one stroke for a whole railway: where
 * the ground has a pair of running lines four and a half metres apart, or six
 * platform roads through a station, the graph has a single line up the middle
 * of them. It is the right answer for routing and the wrong one for drawing —
 * zoomed in, the route visibly lies beside, or across, the track under it.
 *
 * The tiles have the real thing: OpenStreetMap's surveyed track, the same
 * geometry the map draws. So the route can be re-laid onto it.
 *
 * The obstacle is that the route is coarse. Its vertices are 195 m apart on
 * median and 77% of the gaps are over 100 m, so at the zooms where the offset
 * is visible there is often a single vertex on screen and the line you see is
 * one long chord. Snapping vertices would therefore snap almost nothing. The
 * route has to be resampled first — every few tens of metres — and each
 * sample put on the rails. What comes back is a line with the shape of the
 * survey rather than the shape of the graph.
 *
 * Nothing is invented. Where the survey has no track within reach the run
 * ends, and the schematic line still drawn underneath shows that stretch.
 */

import {
  type Line,
  type Point,
  MAX_BEARING_GAP,
  MAX_SNAP_M,
  headingGap,
  snapToLine,
} from './TrackSnap.ts';

/**
 * How far apart to take samples along the route, in metres.
 *
 * Small enough that consecutive samples land on the same surveyed way, which
 * is what keeps the result from stepping between parallel tracks, and that the
 * chord between two of them departs from a curve by well under a pixel: 20 m
 * across a 300 m radius is 17 cm, which at z16 is under a pixel and at z19 is
 * about three. Smaller would cost proportionally more for nothing to see.
 */
export const SAMPLE_M = 20;

/**
 * How much further apart than the sampling step two consecutive snapped points
 * may be before the jump is treated as a break rather than as progress.
 *
 * This catches a sample thrown onto a different way altogether — a crossing
 * line, a siding across the fence — which would otherwise drag a straight line
 * across the drawing. It cannot catch a step sideways onto the track beside
 * this one, which moves a sample by four and a half metres and lengthens the
 * step by centimetres; that is what the stickiness in snapToTrack is for.
 */
const JUMP_FACTOR = 3;
const JUMP_SLACK_M = 10;

/**
 * How much further than the nearest track another may be and still count as
 * the same railway.
 *
 * The running lines of a double track are four and a half metres apart, so the
 * pair is always within this of each other whatever the route's own error. A
 * platform road in a station, or a siding beyond the fence, is not — and must
 * not be, or the rule below would take the route out to the far side of the
 * yard because that is what "furthest to the left" means when everything in
 * sight is a candidate.
 */
const PAIR_M = 6;

const M_PER_DEG = 111_320;

/** One point along the route, with the direction the route runs there. */
export interface Sample {
  lon: number;
  lat: number;
  /** Degrees from north, or null where it is not known. */
  bearing: number | null;
  /**
   * How far this sample may be moved onto the rails, metres.
   *
   * Per sample rather than for the whole run, because it follows from the
   * chord the sample sits on: where the route is drawn as a long straight
   * across a curve it is much further from the track than the usual limit
   * allows, and refusing the correction there breaks the line exactly where it
   * is most visibly wrong. See core/TrackSnap.snapReach.
   */
  reach?: number;
}

export interface MatchOpts {
  /** Metres between samples; only used to size the jump guard. */
  stepM?: number;
  /** How far a sample may be moved onto the rails. */
  maxSnapM?: number;
  /** Which side this railway runs on, at a point. See core/RunningSide. */
  keepLeft?: (lon: number, lat: number) => boolean;
  /**
   * The way the train itself was snapped to, so the route through a station
   * comes out on the same platform road the train is drawn on rather than on
   * whichever of six happened to be nearest the first sample.
   */
  seed?: string | null;
}

/**
 * A candidate track with its extent, so most of them can be dismissed without
 * looking at their segments.
 *
 * A viewport at z14 holds a lot of railway, and every sample would otherwise be
 * measured against every segment of all of it. Comparing four numbers first
 * turns that from the most expensive thing the map does into a rounding error,
 * and the box is computed once per line rather than once per sample.
 */
interface Boxed {
  line: Line;
  w: number;
  e: number;
  s: number;
  n: number;
}

function boxed(lines: readonly Line[]): Boxed[] {
  const out: Boxed[] = [];
  for (const line of lines) {
    if (line.points.length < 2) continue;
    let w = Infinity;
    let e = -Infinity;
    let s = Infinity;
    let n = -Infinity;
    for (const [lon, lat] of line.points) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    out.push({ line, w, e, s, n });
  }
  return out;
}

/** One track that could be the one, with where it sits across the formation. */
interface Cand {
  key: string;
  at: Point;
  /** How far the sample had to move to reach it, metres. */
  d: number;
  /**
   * How far to the side the railway runs on this track lies, metres.
   *
   * Measured from the sample, but only ever compared between candidates — and
   * a common error in the sample shifts every candidate by the same amount, so
   * their order across the formation survives it. That order is the thing the
   * running side is a statement about: of two running lines, one is genuinely
   * to the left of the other, whatever the route thinks its own position is.
   */
  side: number;
}

/**
 * Every track this sample could belong to, with its place across the formation.
 *
 * Bearing-filtered, so a line crossing the route is not a candidate for
 * carrying it.
 */
function candidates(
  s: Sample,
  lines: readonly Line[],
  maxSnapM: number,
  keepLeft: boolean,
): Cand[] {
  // The unit vector pointing to whichever side this railway runs on, in
  // (east, north). Heading north, left is west; in Alsace-Moselle it is the
  // other way about, which keepLeft carries.
  const rad = ((s.bearing ?? 0) * Math.PI) / 180;
  const hand = keepLeft ? 1 : -1;
  const sideE = -Math.cos(rad) * hand;
  const sideN = Math.sin(rad) * hand;
  const kx = M_PER_DEG * Math.cos((s.lat * Math.PI) / 180);

  // One entry per track, not per surveyed way: a way is served once per tile,
  // so the same track arrives in several pieces and only its best projection
  // is of interest.
  const best = new Map<string, Cand>();
  for (const line of lines) {
    const hit = snapToLine(s.lon, s.lat, line);
    if (!hit || hit.movedM > maxSnapM) continue;
    if (s.bearing !== null && headingGap(hit.bearing, s.bearing) > MAX_BEARING_GAP) continue;

    const seen = best.get(line.key);
    if (seen && seen.d <= hit.movedM) continue;
    best.set(line.key, {
      key: line.key,
      at: [hit.lon, hit.lat],
      d: hit.movedM,
      side: (hit.lon - s.lon) * kx * sideE + (hit.lat - s.lat) * M_PER_DEG * sideN,
    });
  }
  return [...best.values()];
}

/**
 * The track the route runs on, of those it could.
 *
 * French trains keep to the left, and to the right in Alsace-Moselle. That is a
 * fact about the railway rather than about the drawing, so on a double track it
 * decides — and being deterministic it cannot flicker, which choosing the
 * nearest track for every sample independently very much could: the schematic
 * route's own offset from the survey is about three metres on median, larger
 * than the four and a half between the running lines, so as it drifts the
 * nearest of the two changes and the drawn line steps sideways between them.
 *
 * The rule is about a pair of running lines and does not generalise past one.
 * Where a third track is in reach the formation is a station or a multi-track
 * section, "the side" is not a statement about anything, and taking whatever
 * lies furthest to the left would walk the route out across the yard. There the
 * track already in use is kept — which is what the train itself was snapped to,
 * on the first sample — and failing that the nearest is taken.
 */
function choose(cands: readonly Cand[], prefer: string | null): Cand | null {
  if (cands.length === 0) return null;

  let nearest = Infinity;
  for (const c of cands) nearest = Math.min(nearest, c.d);
  const pool = cands.filter((c) => c.d <= nearest + PAIR_M);

  if (pool.length === 2) {
    const [a, b] = pool as [Cand, Cand];
    // Level means one track arriving as two ways at a boundary rather than two
    // tracks: keep the one in use, and failing that the lower key, so the
    // answer never depends on the order the tiles were walked in.
    if (Math.abs(a.side - b.side) < 0.05) {
      if (a.key === prefer) return a;
      if (b.key === prefer) return b;
      return a.key <= b.key ? a : b;
    }
    return a.side > b.side ? a : b;
  }

  const held = pool.find((c) => c.key === prefer);
  if (held) return held;
  let best = pool[0]!;
  for (const c of pool) {
    if (c.d < best.d || (c.d === best.d && c.key < best.key)) best = c;
  }
  return best;
}

function metres(a: Point, b: Point): number {
  const kx = M_PER_DEG * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG);
}

/**
 * Lay a resampled route onto the surveyed track.
 *
 * Returns the runs that could be matched, in order — a MultiLineString's worth
 * of coordinates. A run ends wherever the survey does, so a gap in the result
 * is a gap in what is known, not a gap in the journey.
 */
export function matchToRails(
  samples: readonly Sample[],
  lines: readonly Line[],
  opts: MatchOpts = {},
): Point[][] {
  const stepM = opts.stepM ?? SAMPLE_M;
  const maxSnapM = opts.maxSnapM ?? MAX_SNAP_M;
  // Annotated rather than inferred: without it the two sides of the ??
  // infer as a union of function types, and a union cannot be called with
  // arguments that only one member accepts.
  const keepLeft: (lon: number, lat: number) => boolean = opts.keepLeft ?? ((): boolean => true);
  const tolM = stepM * JUMP_FACTOR + JUMP_SLACK_M;

  const boxes = boxed(lines);
  const runs: Point[][] = [];
  let run: Point[] = [];
  let last: Point | null = null;
  // Carried from sample to sample so the line stays on the track it is on:
  // snapToTrack gives the incumbent a few metres' head start, which is just
  // under the spacing of a double-track railway.
  let prefer: string | null = opts.seed ?? null;

  /** A run is only a line if it has two ends. */
  const close = (): void => {
    if (run.length > 1) runs.push(run);
    run = [];
    last = null;
  };

  for (const s of samples) {
    // The reach in degrees, latitude and longitude separately, so the box test
    // is in the same units as the coordinates and needs no trigonometry.
    const reach = s.reach ?? maxSnapM;
    const dLat = reach / M_PER_DEG;
    const dLon = dLat / Math.max(0.3, Math.cos((s.lat * Math.PI) / 180));
    const near: Line[] = [];
    for (const b of boxes) {
      if (b.w - dLon > s.lon || b.e + dLon < s.lon) continue;
      if (b.s - dLat > s.lat || b.n + dLat < s.lat) continue;
      near.push(b.line);
    }

    const hit = choose(candidates(s, near, reach, keepLeft(s.lon, s.lat)), prefer);
    if (!hit) {
      // No surveyed track within reach. Stop the run rather than reaching for
      // the schematic position, which would put a kink of several metres in an
      // otherwise correct line.
      close();
      prefer = null;
      continue;
    }

    const at = hit.at;
    // A break, not a step. Starting a new run here rather than skipping the
    // sample keeps the walk self-correcting: were the point simply dropped,
    // every later sample would be measured against a position the route had
    // long since left, and the rest of the line would be discarded with it.
    if (last && metres(last, at) > tolM) close();

    run.push(at);
    last = at;
    prefer = hit.key;
  }
  close();

  return runs;
}
