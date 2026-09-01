/**
 * How fast each kind of train can actually go.
 *
 * The speed shown for a train is not measured — nothing publishes that. It is
 * the nominal line-speed profile scaled by how long the timetable gives the
 * train to cover the leg, which turns "what this line allows" into "what this
 * train is managing". That scaling has no ceiling of its own, and a train
 * running to a tighter schedule than the nominal profile assumes scales
 * straight past every real limit: a TER was reported at 266 km/h, on a line
 * limited to 220, in stock that cannot exceed 200.
 *
 * Two ceilings are missing there, and both are real. A train cannot exceed the
 * line's own limit, and it cannot exceed what it is built for. Applying them
 * does not make the estimate more accurate — the underlying timetable is
 * saying something odd — but it stops the estimate claiming something that
 * cannot have happened.
 *
 * The figures are fleet maxima rather than what any particular unit does:
 *
 *   tgv    320   the LGV Est and Sud-Europe-Atlantique limit, and what the
 *                current sets are cleared for. Older LGVs are 300.
 *   ic     200   Corail stock, and the locomotives that haul it.
 *   ter    200   most regional units are 160, but the TER 200 between
 *                Strasbourg and Bâle really does run at 200, and it is one of
 *                the trains this was noticed on. Taking the family maximum
 *                rather than the common one means the cap never contradicts a
 *                train that is genuinely doing it.
 *   other  160   navettes and unclassified passenger services.
 */

import type { Family } from '../types.ts';

export const STOCK_MAX_KMH: Readonly<Record<Family, number>> = {
  tgv: 320,
  ic: 200,
  ter: 200,
  other: 160,
};

/**
 * A speed estimate, held to what the line and the train both allow.
 *
 * `limitKmh` is the line speed where the train is, when the geometry knows
 * it. Where it does not, the stock limit still applies: it is a property of
 * the train and needs no map.
 */
export function plausibleSpeed(
  kmh: number,
  family: Family,
  limitKmh?: number | null,
): number {
  const stock = STOCK_MAX_KMH[family] ?? STOCK_MAX_KMH.other;
  const line = limitKmh != null && limitKmh > 0 ? limitKmh : Infinity;
  return Math.max(0, Math.min(kmh, stock, line));
}
