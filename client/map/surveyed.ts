/**
 * The surveyed track, read back out of the tiles already on screen.
 *
 * The station track layout is a vector source, so the only way to get at its
 * geometry is to ask the map what it has drawn. That walk is the most
 * expensive thing this view does — it visits every feature in the viewport —
 * so both answers are cached, and each is cached against the thing that
 * invalidates it: the train having moved, or a couple of seconds having
 * passed.
 *
 * Two answers, because two callers want genuinely different things. Snapping
 * the train wants only what is under it, cut to a box; matching the route
 * wants whole lines across the screen. They used to be two nearly identical
 * copies of the same feature walk, which is why the walk is now one function
 * with the keeping rule passed in.
 */

import type { Line, Point } from '../rail/track-snap.ts';
import type { MapLike } from './maplibre.ts';

/** How long either answer stands before the tiles are walked again. */
const NEAR_MS = 4000;
const VIEW_MS = 2000;

/**
 * A box about 700 m around the train: wide enough to hold any track it
 * could plausibly be on, small enough that what is left is a handful of
 * segments rather than the whole screen.
 */
const BOX_LAT = 0.0063;

/**
 * Walk the drawn track features, handing each line to `take`.
 *
 * The same way is served once per tile, so the id ties the pieces of one
 * track together across tile boundaries. Where there is none, the track
 * number and a rounded coordinate stand in.
 */
function walkTracks(map: MapLike | null, take: (key: string, pts: readonly Point[]) => void): void {
  const feats = map?.querySourceFeatures('osmrail', { sourceLayer: 'tracks' }) ?? [];
  for (const f of feats) {
    const g = f.geometry;
    const ref = String(f.properties?.['railway:track_ref'] ?? '');
    if (g.type === 'LineString') {
      const pts = g.coordinates as Point[];
      take(String(f.id ?? `${ref}@${pts[0]?.[0].toFixed(4)},${pts[0]?.[1].toFixed(4)}`), pts);
    } else if (g.type === 'MultiLineString') {
      for (const [n, l] of (g.coordinates as Point[][]).entries()) {
        take(String(f.id ?? `${ref}@${l[0]?.[0].toFixed(4)},${l[0]?.[1].toFixed(4)}#${n}`), l);
      }
    }
  }
}

export class SurveyedTrack {
  /**
   * Surveyed track near the train, as individual segments — see
   * rail/track-snap.
   *
   * Cut down to the train's neighbourhood rather than kept for the whole
   * viewport. A view at this zoom holds a few thousand segments, and snapping
   * every vehicle against all of them twelve times a second is most of a
   * million distance tests per second for no benefit: a train cannot be near
   * track that is a kilometre away.
   */
  private segs: Line[] = [];
  /** Where and when that was gathered, so it is not re-queried per frame. */
  private segsAt = 0;
  private segsNear: Point | null = null;

  /**
   * Surveyed track across the whole view, as opposed to the box around the
   * train that `segs` holds. Matching the route needs everything on screen;
   * snapping the train needs only what is under it.
   */
  private view: Line[] = [];
  private viewAt = 0;

  /** The segments the last `near` call kept, for looking a chosen line back up. */
  get segments(): readonly Line[] {
    return this.segs;
  }

  /**
   * The drawn track near the train, gathered from the tiles already loaded.
   *
   * Querying the source walks every feature in view, so it is done a few times
   * a minute rather than a few times a second — the surveyed track does not
   * move, and the train covers little ground between refreshes.
   */
  near(map: MapLike | null, lon: number, lat: number): Line[] {
    const now = performance.now();
    const moved =
      this.segsNear === null ||
      Math.abs(lon - this.segsNear[0]) > 0.004 ||
      Math.abs(lat - this.segsNear[1]) > 0.003;
    if (!moved && now - this.segsAt < NEAR_MS) return this.segs;
    this.segsAt = now;
    this.segsNear = [lon, lat];

    const dLat = BOX_LAT;
    const dLon = dLat / Math.max(0.3, Math.cos((lat * Math.PI) / 180));

    const lines: Line[] = [];
    const inBox = (p: Point): boolean =>
      Math.abs(p[0] - lon) < dLon && Math.abs(p[1] - lat) < dLat;

    /**
     * Keep the run of the line that passes near the train, with a point either
     * side so the segments crossing the edge of the box are not lost.
     *
     * Kept as a line rather than loose segments because it needs an identity:
     * the train stays on the track it is already on, and that is only
     * meaningful if one frame's track can be recognised in the next.
     */
    const take = (key: string, pts: readonly Point[]): void => {
      let from = -1;
      let to = -1;
      for (let i = 0; i < pts.length; i++) {
        if (!inBox(pts[i]!)) continue;
        if (from === -1) from = i;
        to = i;
      }
      if (from === -1) return;
      const run = pts.slice(Math.max(0, from - 1), Math.min(pts.length, to + 2));
      if (run.length > 1) lines.push({ key, points: run });
    };

    try {
      walkTracks(map, take);
      this.segs = lines;
    } catch {
      // The layer may not be added, or the source not loaded yet. The train
      // simply stays on the line the model put it on.
      this.segs = [];
    }
    return this.segs;
  }

  /**
   * Every surveyed track in view, whole, for matching the route onto.
   *
   * Deliberately not the box that `near` builds: that one keeps only the run
   * of each line passing within 700 m of the train, which is right for
   * deciding what the train is standing on and useless for drawing a route
   * across the screen. Whole lines also mean the bounding boxes in rail-match
   * are worth having.
   */
  inView(map: MapLike | null): Line[] {
    const now = performance.now();
    // The tiles do not change under a still map, and this is only ever called
    // from a path that already has its own reason not to run continuously.
    // Zero means never gathered, which is not the same as gathered just now:
    // on a page open less than two seconds the difference is the whole cache.
    if (this.viewAt && now - this.viewAt < VIEW_MS) return this.view;

    const lines: Line[] = [];
    const take = (key: string, pts: readonly Point[]): void => {
      if (pts.length > 1) lines.push({ key, points: pts });
    };
    try {
      walkTracks(map, take);
      this.view = lines;
    } catch {
      // The source may not be loaded yet; the schematic line stands until it
      // is, and the next call will find it.
      this.view = [];
    }
    // The clock starts on an answer worth keeping. An empty one means the tiles
    // are still in flight, and holding on to it for the full two seconds delays
    // the matched route by that long after they land — for no saving, since the
    // walk that produced it found nothing to do. Zero means never gathered, so
    // the next call goes and looks again.
    this.viewAt = this.view.length ? now : 0;
    return this.view;
  }
}
