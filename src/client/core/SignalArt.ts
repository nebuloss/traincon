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

import type { TrainDTO } from '../../shared/types.ts';

type Aspect = NonNullable<TrainDTO['traffic']>['aspect'];
type Kind = NonNullable<TrainDTO['traffic']>['signalKind'];

/** The drawings, one per aspect a signal can show here. */
export type SignalKey = 'libre' | 'avertissement' | 'semaphore' | 'carre';

/**
 * The drawing for an aspect, or null when there is nothing to show.
 *
 * `inconnu` draws nothing at all: an unlit signal head would be a claim that
 * the signal is dark, which is a real and serious aspect of its own.
 */
export function signalKey(aspect: Aspect, kind?: Kind): SignalKey | null {
  switch (aspect) {
    case 'libre':
      return 'libre';
    case 'avertissement':
      return 'avertissement';
    case 'semaphore':
      return kind === 'carre' ? 'carre' : 'semaphore';
    default:
      return null;
  }
}
