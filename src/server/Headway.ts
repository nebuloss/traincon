/**
 * Keeps a following train from being drawn on top of the one ahead.
 *
 * The position estimate places each train independently, from its own
 * timetable and its own delay. Nothing in that stops two of them occupying the
 * same piece of track: a fast train catching a slower one is simply drawn
 * closing the gap and then sitting on it, when in reality it would have been
 * held a block short and slowed. It is a regular sight on a busy two-track
 * stretch — Bordeaux to Dax is the example that prompted this.
 *
 * So after positions are computed, trains sharing a line and a direction are
 * put in order and any follower closer than one block is pushed back to it,
 * with its speed cut to match. That is a correction to the *drawing*, not a
 * claim about the signals: it says "this train cannot be here, because that
 * one is", which is true regardless of where the signals stand.
 *
 * Deliberately conservative. It only acts on trains that are demonstrably on
 * the same line heading the same way, and it only ever moves a train
 * backwards — never forwards, which would be inventing progress.
 */

import type { Position } from '../shared/types.ts';

/** What the detector needs to know about a train. */
export interface Follower {
  number: string;
  /** Line identifier, as published in the timetable. */
  line: string;
  position: Position;
}

export interface Held {
  /** The train immediately ahead, whose block this one cannot enter. */
  behind: string;
  /** Metres it was moved back. */
  pushedM: number;
}

/**
 * The signal a driver would be reading, deduced from the traffic ahead.
 *
 * Not observed. SNCF publishes neither signal positions nor their states, so
 * nothing here is a report of a real aspect — it is what French block working
 * implies given how far ahead the next train is, and it must be labelled as
 * deduced wherever it is shown.
 *
 *   libre         nothing close ahead — voie libre
 *   avertissement one block clear, next signal at danger — slow, prepare to stop
 *   semaphore     the block ahead is occupied — stop, then proceed at caution
 *   inconnu       no train ahead identified, so nothing can be said
 */
export type Aspect = 'libre' | 'avertissement' | 'semaphore' | 'inconnu';

export interface Traffic {
  aspect: Aspect;
  /** Train ahead, when one was identified. */
  ahead?: string;
  /** Distance to it, metres. */
  gapM?: number;
  /** Metres this train was pushed back to stay clear of it. */
  pushedM?: number;
  /**
   * Speed the approach allows, km/h — present only when it is a restriction.
   *
   * Absent means the traffic ahead is not constraining this train, so its own
   * speed stands.
   */
  allowedKmh?: number;
}

/**
 * Service braking, m/s² — the same figure the line-speed profile uses, because
 * it is the same train doing the same thing.
 */
const BRAKE_MS2 = 0.5;

/**
 * Speed a train may be doing this far from something it must stop at.
 *
 * The parabolic law, v² = 2·a·d, which is simply what a constant deceleration
 * gives: to stop in d metres at a m/s² you may be doing no more than
 * sqrt(2·a·d) right now. Approaching a signal at danger 1 800 m away that is
 * 42 m/s, or about 150 km/h.
 *
 * The same expression covers coming *off* a restriction, because as the train
 * ahead pulls away d grows and the permitted speed grows with it — a square
 * root, so quickly at first and then gently, which is what letting a train
 * back up to line speed looks like.
 *
 * @param distanceM  metres to the point that must be passed at `targetKmh`
 * @param freeKmh    what the train would be doing with nothing in its way
 * @param targetKmh  speed permitted at that point — zero for a stop signal
 */
export function approachSpeed(distanceM: number, freeKmh: number, targetKmh = 0): number {
  if (!(distanceM > 0)) return Math.min(freeKmh, targetKmh);
  const target = Math.max(0, targetKmh) / 3.6;
  const allowed = Math.sqrt(target * target + 2 * BRAKE_MS2 * distanceM) * 3.6;
  // Never faster than it was going to go anyway: a signal can only restrain a
  // train, never licence it to exceed the line speed or its own timetable.
  return Math.min(freeKmh, allowed);
}

/** Degrees of heading within which two trains count as going the same way. */
const SAME_WAY_DEG = 60;
/** Beyond this the trains are simply elsewhere on a long line. */
const NEIGHBOUR_KM = 40;

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Smallest angle between two headings, in degrees. */
export function headingGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Which trains are running into the back of which.
 *
 * Returns only the trains that need holding; the caller applies the change so
 * that this stays a pure function of the snapshot.
 *
 * @param spacingM minimum spacing at a point, from the block working mode
 */
export function analyseTraffic(
  trains: readonly Follower[],
  spacingM: (lat: number, lon: number) => number,
): Map<string, Traffic> {
  const out = new Map<string, Traffic>();

  // Only trains actually running between stops are constrained: one standing
  // in a station is where the timetable says it is, and one that has arrived
  // is done.
  const moving = trains.filter(
    (t) => t.position.basis === 'between' && t.position.bearing != null && t.line,
  );

  const byLine = new Map<string, Follower[]>();
  for (const t of moving) {
    const arr = byLine.get(t.line);
    if (arr) arr.push(t);
    else byLine.set(t.line, [t]);
  }

  for (const group of byLine.values()) {
    for (const a of group) {
      const pa = a.position;
      const blockKm = spacingM(pa.lat, pa.lon) / 1000;

      // Nearest train ahead on the same line, going the same way.
      let nearest: { train: Follower; gapKm: number } | null = null;
      for (const b of group) {
        if (a.number === b.number) continue;
        const pb = b.position;
        if (headingGap(pa.bearing ?? 0, pb.bearing ?? 0) > SAME_WAY_DEG) continue;
        if ((pb.progress ?? 0) <= (pa.progress ?? 0)) continue;

        const gapKm = haversineKm(pa.lat, pa.lon, pb.lat, pb.lon);
        if (gapKm > NEIGHBOUR_KM) continue;
        if (!nearest || gapKm < nearest.gapKm) nearest = { train: b, gapKm };
      }

      if (!nearest || blockKm <= 0) {
        // No train ahead, or no block working to enforce. Saying "clear" of a
        // line whose signalling we cannot model would be a claim too far.
        out.set(a.number, { aspect: blockKm > 0 ? 'libre' : 'inconnu' });
        continue;
      }

      const { train: ahead, gapKm } = nearest;
      const blocks = gapKm / blockKm;

      // French block working, read off the distance in blocks: inside one, the
      // section ahead is occupied and the signal protecting it is at danger;
      // within two, the next signal is, so this one warns.
      const aspect: Aspect = blocks < 1 ? 'semaphore' : blocks < 2 ? 'avertissement' : 'libre';

      const traffic: Traffic = {
        aspect,
        ahead: ahead.number,
        gapM: Math.round(gapKm * 1000),
      };

      // The signal it is running towards protects the occupied block, so it
      // stands one block behind the train ahead. That is what this train must
      // be able to stop at.
      const toRedM = (gapKm - blockKm) * 1000;
      const freeKmh = pa.speedKmh || 0;
      if (freeKmh > 0) {
        const allowed = approachSpeed(toRedM, freeKmh);
        // Only report it when it actually bites; otherwise the train is
        // unaffected and saying so would be noise.
        if (allowed < freeKmh - 1) traffic.allowedKmh = Math.round(allowed);
      }

      // Inside a block it cannot be where it is drawn; push it back to the
      // boundary. Only ever backwards — moving it forward would invent
      // progress.
      if (blocks < 1) traffic.pushedM = Math.round((blockKm - gapKm) * 1000);

      out.set(a.number, traffic);
    }
  }

  return out;
}
