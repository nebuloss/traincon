/**
 * Keeps the drawn train from jumping.
 *
 * The map recomputes the train's position from the shared motion model twelve
 * times a second, so between server updates it already agrees with the server
 * — there is no drift to correct. What it cannot avoid is the model's *input*
 * changing: when a refresh revises a leg's times, the modelled position moves,
 * and following that instantly makes the train teleport. Backwards, if the
 * delay grew, which reads as the train physically reversing.
 *
 * So the drawn position follows the modelled one rather than equalling it: it
 * closes a fraction of the gap each frame, and never moves backwards while the
 * train is running forwards. An overshoot waits to be caught up rather than
 * sliding back.
 *
 * A gap too large to be a revision of the same journey — a re-identified
 * train, a different route — is taken at once. Easing across kilometres would
 * be a lie about where the train is.
 */

/** Beyond this a gap is a different journey, not a revision of this one. */
const SNAP_KM = 5;
/** Roughly how long closing a gap takes. */
const CONVERGE_MS = 1200;
/** Below this the remaining gap is not worth easing; take it. */
const SETTLE_KM = 0.005;

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
   * Move towards `target`, and report where to draw.
   *
   * @param target  where the model says the train is, in km along the route
   * @param forward whether the train is running, which forbids going backwards
   * @param dtMs    milliseconds since the last call
   */
  follow(target: number, forward: boolean, dtMs: number): number {
    const gap = this.shown === null ? Infinity : Math.abs(target - this.shown);
    // Straight to it when there is nothing to hide: the first position, a jump
    // too big to be this journey, or a gap already down to a few metres —
    // easing that last bit only leaves a permanent lag behind the model.
    if (this.shown === null || gap > SNAP_KM || (gap < SETTLE_KM && !(forward && target < this.shown))) {
      this.shown = target;
      return target;
    }

    // A fixed fraction of the remaining gap per unit time: fast while the gap
    // is wide, imperceptible as it closes, and never overshooting.
    const share = Math.min(1, Math.max(0, dtMs) / CONVERGE_MS);
    let next = this.shown + (target - this.shown) * share;

    // Never reverse under power. A position that ran ahead waits for the model
    // to reach it instead of sliding back to meet it.
    if (forward && next < this.shown) next = this.shown;

    this.shown = next;
    return next;
  }
}
