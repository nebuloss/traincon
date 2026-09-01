/**
 * Which of the day's worst delays to show.
 *
 * The palmarès is a record of the whole day, which is the point of it: a train
 * that lost an hour this morning belongs on the board even though it finished
 * long ago. But by the evening that is most of the board, and a reader wanting
 * to know what is late right now had to read past a dozen trains that arrived
 * hours ago.
 *
 * Kept apart from the view because it is the part with a decision in it, and
 * the view needs a browser to test.
 */

import type { WorstTrainDTO } from '../types.ts';

/** Which trains the board is showing. */
export type WorstFilter = 'all' | 'live';

/**
 * How many to show, and how many to ask for.
 *
 * The board is ranked by delay across the whole day, so filtering it to the
 * running trains takes a slice out of the middle. Asking for the endpoint's
 * maximum and cutting afterwards keeps the live view full enough to be worth
 * looking at; asking for 25 and filtering left three rows on a quiet evening.
 */
export const SHOW = 25;
export const POOL = 50;

/**
 * The rows to show, out of the whole day's board.
 *
 * Filtering on `live` rather than `status === 'running'` deliberately: it is
 * the same flag the row uses to decide whether it can be opened, so what is
 * shown and what can be tapped agree. A train that has left the feed has no
 * position to watch and no detail to open.
 */
export function pickShown(
  trains: readonly WorstTrainDTO[],
  filter: WorstFilter,
  show: number = SHOW,
): WorstTrainDTO[] {
  const kept = filter === 'live' ? trains.filter((r) => r.live) : trains;
  return kept.slice(0, show);
}

