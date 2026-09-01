/**
 * Which signal drawing an aspect calls for.
 *
 * Kept apart from the drawings themselves so it can be checked without a
 * browser: the artwork is imported through the bundler, the choice is plain
 * logic, and the choice is the part with a decision in it.
 *
 * The decision is the difference between a sémaphore and a carré. Both are
 * red, and they mean quite different things: a sémaphore may be passed at
 * caution once the train has stopped, a carré may not be passed at all. The
 * signalling layer knows which is which where it has the data, and where it
 * does not this draws the sémaphore — much the commoner signal on plain line
 * — but the drawing for it leaves the œilleton off rather than asserting a
 * permissiveness nothing has established.
 */

import type { TrainDTO } from '../types.ts';

type Aspect = NonNullable<TrainDTO['traffic']>['aspect'];
type Kind = NonNullable<TrainDTO['traffic']>['signalKind'];

/** The drawings, one per aspect. */
export type SignalKey = 'vl' | 'a' | 'semaphore' | 'carre';

/**
 * The drawing for an aspect, or null when there is nothing to show.
 *
 * `inconnu` draws nothing at all: an unlit head would be a claim that the
 * signal is dark, which is a real and serious aspect of its own.
 *
 * A carré and a sémaphore are both drawn as one red. On a real five-lamp
 * target a carré is two reds, but a head that size leaves each lens a few
 * pixels across at the size this is shown, so the head is the familiar three
 * and the two are told apart by the œilleton — which is the mark that
 * distinguishes them on the ground anyway, and on some installations the only
 * visible one.
 */
export function signalKey(aspect: Aspect, kind?: Kind): SignalKey | null {
  switch (aspect) {
    case 'libre':
      return 'vl';
    case 'avertissement':
      return 'a';
    case 'semaphore':
      return kind === 'carre' ? 'carre' : 'semaphore';
    default:
      return null;
  }
}
