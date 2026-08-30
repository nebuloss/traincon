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

/**
 * The drawings. Two panels, because a real signal has two: one that can show
 * a carré carries five lamp positions, one that can only show a sémaphore
 * carries the lower three. The suffix says which panel.
 */
export type SignalKey = 'vl' | 'a' | 'semaphore' | 'vl-carre' | 'a-carre' | 'carre';

/**
 * The drawing for an aspect, or null when there is nothing to show.
 *
 * `inconnu` draws nothing at all: an unlit head would be a claim that the
 * signal is dark, which is a real and serious aspect of its own.
 *
 * The panel follows the signal, not the aspect, so it stays the same size as
 * a train runs up to it and the picture does not jump. Where the kind is not
 * known the shorter panel is drawn — the sémaphore is much the commoner
 * signal on plain line — and its œilleton is left off rather than asserting a
 * permissiveness nothing has established.
 */
export function signalKey(aspect: Aspect, kind?: Kind): SignalKey | null {
  const carre = kind === 'carre';
  switch (aspect) {
    case 'libre':
      return carre ? 'vl-carre' : 'vl';
    case 'avertissement':
      return carre ? 'a-carre' : 'a';
    case 'semaphore':
      return carre ? 'carre' : 'semaphore';
    default:
      return null;
  }
}
