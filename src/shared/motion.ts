/**
 * Where a train is along a leg at a given moment.
 *
 * Both sides run this. The server evaluates it once a minute when the feed
 * refreshes; the map evaluates it twelve times a second so the train moves.
 * Same function, same inputs, different rate — so the two cannot drift apart,
 * and the animation needs no correction because it is not an approximation of
 * the server's answer, it *is* the server's answer at a finer interval.
 *
 * The input is the leg's motion profile: where the train has got to, as a
 * fraction of the distance, at each of a series of equally spaced moments. It
 * is not a straight line — a train spends its first and last kilometres
 * accelerating and braking, so it covers less ground at the start and end of a
 * leg than in the middle.
 */

/**
 * Samples per leg.
 *
 * Uniform, and simply enough of them. The curve bends where the train changes
 * speed, and that is not only at the ends — a speed restriction puts a bend in
 * the middle — so clustering samples at the ends was tried and made the
 * restriction case worse than it fixed the approach case. Even spacing has no
 * such failure mode.
 *
 * Measured worst-case error against the exact curve, over uniform lines, short
 * legs, mid-leg restrictions and repeated limit changes: about 130 m on a
 * 500 km leg, and under 30 m on anything of ordinary length. That sits well
 * inside the uncertainty of the position itself, which comes from a feed that
 * only observes trains where they stop.
 */
export const PROFILE_SAMPLES = 128;

/**
 * Build the profile from a path's distance and time curves.
 *
 * Server-side, once per routed leg. `cum` and `cumT` are cumulative distance
 * and cumulative nominal time at each vertex.
 */
export function sampleProfile(cum: readonly number[], cumT: readonly number[]): number[] {
  const n = cum.length;
  if (n < 2 || cumT.length !== n) return [];

  const totalD = cum[n - 1]!;
  const totalT = cumT[n - 1]!;
  if (!(totalD > 0) || !(totalT > 0)) return [];

  const out: number[] = new Array(PROFILE_SAMPLES + 1);
  let j = 1;
  for (let k = 0; k <= PROFILE_SAMPLES; k++) {
    const t = (k / PROFILE_SAMPLES) * totalT;
    while (j < n - 1 && cumT[j]! < t) j++;
    const dt = cumT[j]! - cumT[j - 1]!;
    const within = dt > 0 ? (t - cumT[j - 1]!) / dt : 0;
    const d = cum[j - 1]! + (cum[j]! - cum[j - 1]!) * within;
    out[k] = d / totalD;
  }
  // Pin the ends: rounding must not leave a train short of its own terminus.
  out[0] = 0;
  out[PROFILE_SAMPLES] = 1;
  return out;
}

/**
 * Fraction of the leg's distance covered, at a fraction of its duration.
 *
 * Falls back to a straight line when there is no profile — a leg with no
 * routed geometry — which is the same assumption the rest of the code makes
 * about those.
 */
export function distanceFraction(profile: readonly number[] | undefined, timeFraction: number): number {
  const f = timeFraction < 0 ? 0 : timeFraction > 1 ? 1 : timeFraction;
  if (!profile || profile.length < 2) return f;

  const last = profile.length - 1;
  const x = f * last;
  const i = Math.min(last - 1, Math.floor(x));
  const a = profile[i]!;
  return a + (profile[i + 1]! - a) * (x - i);
}
