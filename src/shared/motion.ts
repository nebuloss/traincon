/**
 * Where a train is along a leg at a given moment.
 *
 * The server samples the profile once per routed leg and sends it in the
 * journey payload; this evaluates it twelve times a second so the train moves.
 * The split is the point: the browser is reading the server's own answer at a
 * finer interval, not approximating it, so the two cannot drift apart — and
 * the sampling half lives in the Go server, in internal/motion.
 *
 * The input is the leg's motion profile: where the train has got to, as a
 * fraction of the distance, at each of a series of equally spaced moments. It
 * is not a straight line — a train spends its first and last kilometres
 * accelerating and braking, so it covers less ground at the start and end of a
 * leg than in the middle.
 */

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
