/**
 * Reading a lookup that came back empty.
 *
 * Sits in core/ because it interprets the API contract rather than any one
 * screen: the bookmark list uses it to decide how to draw the card, and the
 * modal uses it to decide whether there is anything worth opening.
 */

import type { MissingReason, TrainNotFound } from '../types.ts';

/**
 * Which kind of miss this is.
 *
 * Older servers predate the `reason` field, so a known timetable entry is
 * taken as dormant — the safe reading, since calling a real train "unknown"
 * would invite the user to delete a bookmark that is perfectly good.
 */
export function missingKind(res: Pick<TrainNotFound, 'reason' | 'knownSchedule'>): MissingReason {
  return res.reason ?? (res.knownSchedule ? 'dormant' : 'unknown');
}
