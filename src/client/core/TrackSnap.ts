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
 *
 * One track, and the right one. The first version took whichever track was
 * nearest, for each vehicle, every frame — wrong three times over on a
 * double-track line. The two running lines are about four and a half metres
 * apart and both point the same way, so "nearest" alternated between them as
 * the centreline wandered and the train appeared to change track
 * continuously; each vehicle chose for itself, so a 200 m set could straddle
 * both at once; and nearest is a coin toss anyway, because which track a
 * train uses is not a matter of proximity.
 *
 * It is a matter of which way it is going. **French trains run on the left**,
 * unlike the roads. So the track is chosen by side: of the candidates within
 * reach and pointing the right way, the one to the left of the direction of
 * travel wins. That is deterministic, so it does not flicker, and it is what
 * the train is actually doing.
 *
 * Which side that is, is not the same everywhere: Alsace-Moselle runs on the
 * right. Deciding that is core/RunningSide's job, and the answer arrives here
 * as `keepLeft`.
 *
 * The choice is made once for the whole train and then held, so noise in
 * either survey cannot push it across.
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

/** A surveyed track, with something to recognise it by between frames. */
export interface Line {
  /** Stable enough to tell one running line from the one beside it. */
  key: string;
  points: readonly Point[];
}

/**
 * How much nearer a different track has to be before the train moves across.
 *
 * A shade under the four and a half metres between the running lines of a
 * double-track railway: enough that noise in either survey cannot push the
 * train from one to the other, not so much that it clings to a track it has
 * genuinely left.
 */
export const STICKY_M = 4;

/**
 * How far onto the wrong side a track may be and still count as the right one.
 *
 * It exists only so that a train sitting all but exactly on its own rails is
 * not judged to be on the other side of itself by a few centimetres of survey
 * noise. Any more and it stops being a slack: with a metre of it, the
 * right-hand rail of a four-and-a-half-metre pair qualifies as left whenever
 * the train drifts towards it, which is the flicker all over again.
 */
const SIDE_SLACK_M = 0.1;

/** The closest point on one particular line, wherever it is. */
export function snapToLine(lon: number, lat: number, line: Line): Snapped | null {
  return nearest(lon, lat, null, [line], Infinity)?.hit ?? null;
}

/**
 * The track to put the train on, or null to leave it where the model has it.
 *
 * `bearing` is where the train is heading, in degrees from north; pass null
 * when it is not known and the check is skipped. `prefer` is the key of the
 * track it is already on, which wins ties and near-ties. `keepLeft` is which
 * side this bit of railway runs on — see core/RunningSide.
 */
export function snapToTrack(
  lon: number,
  lat: number,
  bearing: number | null,
  lines: readonly Line[],
  maxM: number = MAX_SNAP_M,
  prefer?: string | null,
  keepLeft = true,
): (Snapped & { key: string }) | null {
  const found = nearest(lon, lat, bearing, lines, maxM, prefer, keepLeft);
  return found ? { ...found.hit, key: found.key } : null;
}

/** The shared search. Distances are scored, so stickiness can bias them. */
function nearest(
  lon: number,
  lat: number,
  bearing: number | null,
  lines: readonly Line[],
  maxM: number,
  prefer?: string | null,
  keepLeft = true,
): { hit: Snapped; key: string } | null {
  // Local flat-earth metres. Over the tens of metres in question the error is
  // far below the thing being measured.
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const px = lon * kx;
  const py = lat * M_PER_DEG;

  // Two answers are kept: the best track on the side this railway runs on,
  // and the best of any. The first wins if there is one — see the note above
  // — and the other is there for single track, where there is no side.
  let best: { hit: Snapped; key: string } | null = null;
  let bestScore = maxM;
  let bestSide: { hit: Snapped; key: string } | null = null;
  let bestSideScore = maxM;

  // The running side, as a unit vector in (east, north). Heading north, left
  // is west; heading east, left is north. In Alsace-Moselle it is the other
  // way about, which `keepLeft` carries.
  const rad = ((bearing ?? 0) * Math.PI) / 180;
  const hand = keepLeft ? 1 : -1;
  const sideE = -Math.cos(rad) * hand;
  const sideN = Math.sin(rad) * hand;

  for (const line of lines) {
    const pts = line.points;
    // The track it is already on gets a head start, so a rival has to be
    // clearly nearer rather than a few centimetres nearer.
    const bonus = prefer !== null && prefer !== undefined && line.key === prefer ? STICKY_M : 0;

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
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
      if (d > maxM) continue;
      const score = d - bonus;
      // Pruned against both answers, not just the overall best: the track on
      // the correct side is often no nearer than the one beside it, and
      // stopping at the first equally-good candidate would never see it.
      if (score >= bestScore && score >= bestSideScore) continue;

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

      const found = {
        key: line.key,
        hit: {
          lon: fx / kx,
          lat: fy / M_PER_DEG,
          movedM: d,
          bearing: ((seg % 360) + 360) % 360,
        },
      };

      if (score < bestScore) {
        bestScore = score;
        best = found;
      }

      // Which side of the train this track lies on.
      const sideness = (fx - px) * sideE + (fy - py) * sideN;
      if (bearing !== null && sideness > -SIDE_SLACK_M && score < bestSideScore) {
        bestSideScore = score;
        bestSide = found;
      }
    }
  }

  return bestSide ?? best;
}
