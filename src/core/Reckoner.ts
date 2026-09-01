/**
 * Keeps the drawn train from jumping, by adjusting its speed rather than its
 * position.
 *
 * The map recomputes the train's position from the shared motion model many
 * times a second, so between refreshes it already agrees with the server.
 * What it cannot avoid is the model's *input* changing: a refresh that revises
 * a leg's times moves the modelled position, and following that directly makes
 * the train teleport — backwards, if the delay grew, which reads as the train
 * physically reversing.
 *
 * Easing the position across the gap fixes the jump but not the lie: the train
 * slides at a rate unrelated to how fast it is supposed to be going. So the
 * correction is applied to speed instead. The drawn train runs a little faster
 * to catch up, or a little slower to be caught up, and its position is always
 * the integral of a plausible speed. It is therefore continuous by
 * construction, and can never reverse, because the drawn speed is never
 * allowed below zero — an overshoot simply coasts to a stand and waits.
 *
 * A gap too large to be the same journey — a re-identified train, a different
 * route — is taken at once. No believable speed closes twenty kilometres, and
 * pretending otherwise would put the train somewhere it is not for minutes.
 */

/** Beyond this a gap is a different journey, not a revision of this one. */
const SNAP_KM = 5;
/** The gap should be gone in about this long. */
const HORIZON_MS = 8000;
/** How much faster than reported the drawn train may run to catch up. */
const MAX_FACTOR = 1.6;
/** Catch-up speed available even to a train the model says is stopped. */
const MIN_CATCHUP_KMH = 30;
/** Below this the gap is not worth correcting at all. */
const SETTLE_KM = 0.003;

export class Reckoner {
  private shown: number | null = null;

  /** Forget everything, so the next position is taken as-is. */
  reset(): void {
    this.shown = null;
  }

  /** The position currently drawn, or null before the first one. */
  get current(): number | null {
    return this.shown;
  }

  /**
   * Advance the drawn train towards where the model says it is.
   *
   * @param target   modelled position, km along the route
   * @param kmh      speed the train is reported to be doing
   * @param dtMs     milliseconds since the last call
   * @param maxKmh   what the line and the stock allow, if known
   * @returns        where to draw it, km along the route
   */
  follow(target: number, kmh: number, dtMs: number, maxKmh = Infinity): number {
    if (this.shown === null || Math.abs(target - this.shown) > SNAP_KM) {
      this.shown = target;
      return target;
    }

    const gap = target - this.shown;
    if (Math.abs(gap) < SETTLE_KM) {
      this.shown = target;
      return target;
    }

    // The speed that would close the gap over the horizon, on top of the
    // train's own. Positive gap means the model is ahead and it hurries;
    // negative means it has overrun and eases off.
    const correction = gap / (HORIZON_MS / 3_600_000);
    // Catching up is still running, and running is still bounded by the line
    // and the stock. The reported speed is already held to both, but the
    // catch-up allowance sat on top of it: a TER reported at its 160 ceiling
    // was drawn covering ground at 256 to close a gap, which is how a regional
    // unit came to be seen doing speeds it does not have. Being late is not a
    // dispensation — a delayed train closes its gap by taking longer, which is
    // what a real one does.
    const physical = maxKmh > 0 ? maxKmh : Infinity;
    const ceiling = Math.min(physical, Math.max(kmh * MAX_FACTOR, MIN_CATCHUP_KMH));

    // Never below zero: that is the whole guarantee. A train that has overrun
    // slows, stops if it must, and waits to be caught up — it does not reverse.
    const drawnKmh = Math.min(ceiling, Math.max(0, kmh + correction));

    const dt = Math.max(0, dtMs);
    let next = this.shown + drawnKmh * (dt / 3_600_000);

    // Do not sail past the target while catching up to it.
    if (gap > 0) next = Math.min(next, target);
    this.shown = next;
    return next;
  }
}
