/**
 * Put the train on the track that is actually drawn under it.
 *
 * The train is placed along the journey line, which the server builds from
 * SNCF Réseau's published network geometry. The rails beneath it are drawn
 * from OpenStreetMap. Both are honest surveys of the same railway and they
 * mostly agree — measured over one route, a median of 3 m apart — but SNCF's
 * vertices are sparse in places: a tenth of the segments on that route are
 * over 460 m long, and a straight chord that long cuts the corner of a curve.
 * A 414 m chord across an 800 m radius sits 27 m inside it, which at the zoom
 * the plan view appears at is a train drawn clearly beside its own rails.
 *
 * Curving the route through its own vertices was tried and measured: it made
 * things slightly worse, because most of those long segments are on genuinely
 * straight track where the chord is right. So instead of guessing at the
 * alignment, this uses the one that is already on screen and moves the train
 * sideways onto it.
 *
 * Sideways only. The along-track position is the model's answer and is not
 * second-guessed; this shifts the train perpendicular to its own heading, and
 * only when there is a track close by and pointing the same way. Where there
 * is not — no tiles loaded, a station throat full of parallel roads, a gap in
 * the survey — it declines and the train stays where the model put it.
 */

/** A point on the ground. `[lon, lat]`, as GeoJSON has it. */
export type Point = readonly [number, number];

/** Beyond this the nearest track is not plausibly the one the train is on. */
export const MAX_SNAP_M = 30;

/**
 * How far a track may point away from the train before it is the wrong track.
 *
 * Generous, because the train's own heading comes from a coarse line and can
 * be a few degrees out on a curve; tight enough to reject a crossing line or
 * a siding trailing in at an angle.
 */
export const MAX_BEARING_GAP = 40;

const M_PER_DEG = 111_320;

/** Difference between two undirected bearings, 0-90. A rail has no front. */
export function headingGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

export interface Snapped {
  lon: number;
  lat: number;
  /** How far the train was moved, metres — worth knowing before trusting it. */
  movedM: number;
  /**
   * The direction of the track it landed on, turned to agree with the way the
   * train was already going.
   *
   * Moving a vehicle onto the rails while leaving it pointing along the coarse
   * chord it came from would be worse than leaving it alone: it would sit on
   * the track at an angle to it. Taking the angle from the same segment as
   * the position keeps the two consistent.
   */
  bearing: number;
}

/**
 * The closest point on any of `lines` to the train, or null to leave it be.
 *
 * `bearing` is where the train is heading, in degrees from north; pass null
 * when it is not known and the check is skipped.
 */
export function snapToTrack(
  lon: number,
  lat: number,
  bearing: number | null,
  lines: readonly (readonly Point[])[],
  maxM: number = MAX_SNAP_M,
): Snapped | null {
  // Local flat-earth metres. Over the tens of metres in question the error is
  // far below the thing being measured.
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const px = lon * kx;
  const py = lat * M_PER_DEG;

  let best: Snapped | null = null;
  let bestD = maxM;

  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const ax = a[0] * kx;
      const ay = a[1] * M_PER_DEG;
      const bx = b[0] * kx;
      const by = b[1] * M_PER_DEG;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;

      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const fx = ax + t * dx;
      const fy = ay + t * dy;
      const d = Math.hypot(px - fx, py - fy);
      if (d >= bestD) continue;

      // atan2(east, north), which is a compass bearing.
      let seg = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (bearing !== null) {
        if (headingGap(seg, bearing) > MAX_BEARING_GAP) continue;
        // A rail has no front: the segment may be drawn against the train's
        // direction of travel, in which case its reverse is the one meant.
        // Signed difference in (-180, 180]; more than a quarter turn apart
        // means the segment runs the other way.
        const diff = ((((seg - bearing) % 360) + 540) % 360) - 180;
        if (Math.abs(diff) > 90) seg += 180;
      }

      bestD = d;
      best = { lon: fx / kx, lat: fy / M_PER_DEG, movedM: d, bearing: ((seg % 360) + 360) % 360 };
    }
  }

  return best;
}
