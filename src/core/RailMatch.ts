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

import { type Line, type Point, MAX_SNAP_M, snapToTrack } from './TrackSnap';

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

const M_PER_DEG = 111_320;

/** One point along the route, with the direction the route runs there. */
export interface Sample {
  lon: number;
  lat: number;
  /** Degrees from north, or null where it is not known. */
  bearing: number | null;
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
  const keepLeft = opts.keepLeft ?? ((): boolean => true);
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
    const dLat = maxSnapM / M_PER_DEG;
    const dLon = dLat / Math.max(0.3, Math.cos((s.lat * Math.PI) / 180));
    const near: Line[] = [];
    for (const b of boxes) {
      if (b.w - dLon > s.lon || b.e + dLon < s.lon) continue;
      if (b.s - dLat > s.lat || b.n + dLat < s.lat) continue;
      near.push(b.line);
    }

    const hit = snapToTrack(
      s.lon,
      s.lat,
      s.bearing,
      near,
      maxSnapM,
      prefer,
      keepLeft(s.lon, s.lat),
    );
    if (!hit) {
      // No surveyed track within reach. Stop the run rather than reaching for
      // the schematic position, which would put a kink of several metres in an
      // otherwise correct line.
      close();
      prefer = null;
      continue;
    }

    const at: Point = [hit.lon, hit.lat];
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
