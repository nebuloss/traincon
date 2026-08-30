/**
 * Reconciles the animated position with the server's, without jumping.
 *
 * Dead reckoning between updates creates a problem it does not have on its
 * own: every thirty seconds a real position arrives, and it will not be where
 * the estimate had got to. Snapping to it makes the train teleport — forward
 * if the estimate lagged, backward if it ran ahead — which is worse than the
 * stationary marker this replaced, because it looks like the train physically
 * reversed.
 *
 * So a correction is never applied at once. The displayed position starts
 * exactly where it already was and converges onto the server's trajectory over
 * a few seconds. And it never moves backwards while the train is going
 * forwards: if the estimate overran, the train holds until the true position
 * catches up, which reads as a brief pause rather than a reversal.
 *
 * The one exception is a correction too large to blend away — a train
 * re-identified, or a feed revision moving it kilometres. Sliding smoothly
 * across that would be a lie about where it is, so it snaps and says so.
 */

/** Errors bigger than this are a real revision, not drift. */
const SNAP_KM = 5;
/** How long a blended correction takes to disappear. */
const CONVERGE_MS = 4000;

export class Reckoner {
  /** Server trajectory: distance at `since`, advancing at `kmh`. */
  private base = 0;
  private kmh = 0;
  private since = 0;
  /** Error carried at `since`, decayed to zero over CONVERGE_MS. */
  private error = 0;
  /** Last distance actually shown, so motion can be kept monotonic. */
  private shown: number | null = null;

  /** Forget everything; the next update starts clean. */
  reset(): void {
    this.shown = null;
    this.error = 0;
    this.kmh = 0;
  }

  /**
   * Take a fresh server position.
   *
   * @returns 'snap' when the correction was too large to blend, else 'blend'.
   */
  update(distKm: number, kmh: number, now: number): 'snap' | 'blend' {
    const first = this.shown === null;
    const shown = first ? distKm : this.at(now);
    const error = shown - distKm;

    this.base = distKm;
    this.kmh = kmh;
    this.since = now;

    if (first || Math.abs(error) > SNAP_KM) {
      this.error = 0;
      this.shown = distKm;
      return 'snap';
    }

    this.error = error;
    this.shown = shown;
    return 'blend';
  }

  /** Where to draw the train now. */
  at(now: number): number {
    if (this.shown === null) return this.base;

    const elapsed = Math.max(0, now - this.since);
    const decay = Math.max(0, 1 - elapsed / CONVERGE_MS);
    const wanted = this.base + this.kmh * (elapsed / 3_600_000) + this.error * decay;

    // Never reverse while running forward. An overshooting estimate waits for
    // the true position to reach it instead of sliding back to meet it.
    const next = this.kmh > 0 ? Math.max(this.shown, wanted) : wanted;
    this.shown = next;
    return next;
  }
}
