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
 * right. Deciding that is rail/running-side's job, and the answer arrives here
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

/**
 * The furthest a train may be moved onto the rails where the route is coarse.
 *
 * The plain limit assumes the drawn position is nearly right and only needs
 * nudging sideways. On a winding single-track line it is not: the route is a
 * polyline, its chords cut the corners, and on the Ligne des Alpes 18.7% of the
 * drawn line lies more than thirty metres from the rails, sixty-one at worst.
 * The correction was refused exactly where it was most needed, which is a train
 * drawn in a field beside its own track.
 *
 * Allowed only in proportion to the chord responsible — see snapReach — so a
 * station, where the route is dense, keeps the tight limit that stops a train
 * jumping to the platform road next door.
 */
export const MAX_SNAP_FAR_M = 80;

/**
 * How far a train at this point may be moved onto the rails.
 *
 * A chord of length L across a curve departs from it by L squared over eight
 * times the radius; a quarter of L bounds that for any curve a railway is built
 * with, and is well under the half-chord that is its absolute limit.
 */
export function snapReach(chordM: number): number {
  return Math.max(MAX_SNAP_M, Math.min(MAX_SNAP_FAR_M, chordM / 4));
}

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

/**
 * How much further than the nearest track another may be and still count as
 * part of the same formation.
 *
 * The running lines of a double track are four and a half metres apart, so the
 * pair is always within this of each other whatever the route's own error. A
 * platform road in a station, or a siding beyond the fence, is not — and must
 * not be, or the rule below would take the train out across the yard.
 */
export const PAIR_M = 6;

/**
 * Two candidates level enough across the formation to be one track arriving as
 * two ways at a tile boundary, rather than two tracks.
 */
const LEVEL_M = 0.05;

/** A track the point could be on, and where it sits across the formation. */
export interface Across {
  key: string;
  /** How far the point would have to move to reach it, metres. */
  d: number;
  /**
   * How far to the side the railway runs on this track lies, metres.
   *
   * Measured from the point, but — for a pair — only ever compared between
   * candidates, which is what makes it survive the point being wrong. See
   * chooseTrack.
   */
  side: number;
}

export interface ChooseOpts {
  /** The track already in use, if there is one. */
  prefer?: string | null;
  /**
   * Whether `prefer` settles the matter or merely biases it.
   *
   * The two callers mean different things by it. The route is seeded with the
   * track the train was placed on, which is authoritative: the running side
   * has already had its say, in placing the train, and the route should follow
   * the train onto whatever it is really running on. The train is biased by
   * the track it was on last frame, which is a guess — enough to stop noise
   * pushing it across, never enough to hold it on the wrong side.
   */
  binding?: boolean;
}

/**
 * Which of several parallel tracks the train is on.
 *
 * Shared with the route matcher, because the two were deciding the same thing
 * by different rules and disagreeing. The route compared its candidates
 * against each other; the train asked whether each candidate was on the left
 * of where the model had put it. Those differ exactly when the model's
 * position is not between the rails — and the two surveys sit about three
 * metres apart on median, against two and a quarter from the centreline to
 * either rail, so that is most of the time. Beyond that offset both rails are
 * on the same side of the train, the absolute test admits both, and distance
 * decided: the nearer one, which is the wrong one. That is a train drawn
 * running on the wrong track, and it was reported as one.
 *
 * So a pair is settled by comparison. A common error in the position shifts
 * both candidates by the same amount, so their order across the formation
 * survives it, and the left-hand rail of a pair stays the left-hand rail
 * however far out the centreline is.
 *
 * Past two the comparison means nothing: a station throat or a four-track
 * section has no "side", and taking whatever lies furthest to the left would
 * walk the train across the yard. There the track already in use is kept, and
 * failing that the nearest — but out of those on the running side, because a
 * preference is a bias among plausible tracks and not a licence to sit on the
 * wrong one.
 */
export function chooseTrack<T extends Across>(
  cands: readonly T[],
  opts: ChooseOpts = {},
): T | null {
  if (cands.length === 0) return null;
  const { prefer = null, binding = false } = opts;

  // A binding preference is the answer, not a candidate for one. The route
  // takes it from the track the train was actually placed on, and a train
  // genuinely on the other line — single track, engineering works, a
  // wrong-line movement — is still where its route belongs.
  if (binding && prefer !== null) {
    const held = cands.find((c) => c.key === prefer);
    if (held) return held;
  }

  let nearestD = Infinity;
  for (const c of cands) nearestD = Math.min(nearestD, c.d);
  const pool = cands.filter((c) => c.d <= nearestD + PAIR_M);

  if (pool.length === 2) {
    const [a, b] = pool as [T, T];
    // Level means one track arriving as two ways at a boundary rather than two
    // tracks: keep the one in use, and failing that the lower key, so the
    // answer never depends on the order the tiles were walked in.
    if (Math.abs(a.side - b.side) < LEVEL_M) {
      if (a.key === prefer) return a;
      if (b.key === prefer) return b;
      return a.key <= b.key ? a : b;
    }
    return a.side > b.side ? a : b;
  }

  const closest = (of: readonly T[]): T => {
    let best = of[0]!;
    for (const c of of) if (c.d < best.d || (c.d === best.d && c.key < best.key)) best = c;
    return best;
  };

  // Nothing on the running side at all — single track, or a train the model
  // has put beyond the whole formation. There is no side to be on, so the
  // nearest track is the whole answer.
  const onSide = cands.filter((c) => c.side > -SIDE_SLACK_M);
  if (onSide.length === 0) return closest(cands);

  const best = closest(onSide);
  const held = onSide.find((c) => c.key === prefer);
  // The incumbent keeps its place while it is still a plausible answer, so
  // noise cannot push the train across; STICKY_M is a shade under the spacing
  // of a double track, so it cannot cling to one it has genuinely left.
  return held && held.d - best.d <= STICKY_M ? held : best;
}

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
 * side this bit of railway runs on — see rail/running-side.
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

/**
 * The shared search: the nearest acceptable point on each track in reach.
 *
 * One candidate per track rather than per segment — a track arrives as several
 * ways across tile boundaries and only its nearest point is of interest — and
 * then chooseTrack settles which of them the train is on.
 */
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

  // The running side, as a unit vector in (east, north). Heading north, left
  // is west; heading east, left is north. In Alsace-Moselle it is the other
  // way about, which `keepLeft` carries.
  const rad = ((bearing ?? 0) * Math.PI) / 180;
  const hand = keepLeft ? 1 : -1;
  const sideE = -Math.cos(rad) * hand;
  const sideN = Math.sin(rad) * hand;

  const found = new Map<string, Across & { hit: Snapped }>();

  for (const line of lines) {
    const pts = line.points;
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

      // Only the nearest acceptable segment of this track. Checked before the
      // bearing work below, which is the expensive part.
      const seen = found.get(line.key);
      if (seen && seen.d <= d) continue;

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

      found.set(line.key, {
        key: line.key,
        d,
        side: (fx - px) * sideE + (fy - py) * sideN,
        hit: {
          lon: fx / kx,
          lat: fy / M_PER_DEG,
          movedM: d,
          bearing: ((seg % 360) + 360) % 360,
        },
      });
    }
  }

  const cands = [...found.values()];
  if (cands.length === 0) return null;

  // No direction means no side to be on, so the nearest point is the whole
  // answer. That is what snapToLine asks for.
  if (bearing === null) {
    let best = cands[0]!;
    for (const c of cands) if (c.d < best.d) best = c;
    return best;
  }

  return chooseTrack(cands, { prefer });
}
