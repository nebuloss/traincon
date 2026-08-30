/**
 * Where each vehicle of a train sits on the track.
 *
 * The train is drawn from artwork — one SVG per kind of vehicle, in
 * `assets/train`, loaded by `TrainArt` — and this works out which vehicles a
 * train is made of and where to put each one. A vehicle is rigid, so it gets
 * a point and an angle; the couplings are not, so the angles differ down the
 * train and the whole thing bends round a curve the way the real one does.
 *
 * That is why the train is not one icon. A 200 m set on the curve into a
 * station spans a noticeable arc, and a single rigid image laid over it
 * stands about 8 m off the rails at each end — the sagitta of a 200 m chord
 * on a 600 m radius. Per vehicle, the worst error is a fraction of that.
 *
 * The three families are put together differently, and from above the
 * difference is the obvious thing about them:
 *
 *   tgv   a motrice at each end, articulated remorques between. Both ends are
 *         noses, which is why a TGV looks the same coming or going.
 *   ic    a locomotive on the front and a rake of Corail coaches behind it —
 *         the loco shorter than what it hauls, and blunt where a TGV points.
 *   ter   a multiple unit: a cab car at each end, plain cars between, and no
 *         separate locomotive at all.
 *
 * Lengths here are the real ones, and `test/trainbody` checks them against
 * the artwork's own viewBox so the two cannot drift apart.
 */

import { Track } from './Track.ts';
import type { Family, TrainCarsGeo, VehicleRole } from '../../shared/types.ts';

/** Real length of each vehicle, metres. */
export const VEHICLE_M: Readonly<Record<VehicleRole, number>> = {
  power: 22.1,
  artic: 18.7,
  loco: 17.5,
  coach: 26.4,
  'emu-cab': 27,
  'emu-mid': 27,
};

/**
 * What a train of this length and family is made of, back to front.
 *
 * The count falls out of the length rather than the other way round, so a
 * 400 m coupled TGV gets twice the remorques of a 200 m one — which is what
 * you see beside a platform built for it.
 */
export function consist(family: Family, lengthM: number, maxCars = 24): VehicleRole[] {
  const ends: VehicleRole[] = family === 'tgv' ? ['power', 'power'] : family === 'ic' ? [] : ['emu-cab', 'emu-cab'];
  const middle: VehicleRole = family === 'tgv' ? 'artic' : family === 'ic' ? 'coach' : 'emu-mid';
  // Only a hauled train has a vehicle that is not part of the rake.
  const lead: VehicleRole | null = family === 'ic' ? 'loco' : null;

  const fixed = ends.reduce((a, r) => a + VEHICLE_M[r], 0) + (lead ? VEHICLE_M[lead] : 0);
  const room = Math.max(0, lengthM - fixed);
  const budget = Math.max(1, maxCars - ends.length - (lead ? 1 : 0));
  const n = Math.max(1, Math.min(budget, Math.round(room / VEHICLE_M[middle])));
  const rake: VehicleRole[] = new Array(n).fill(middle);

  if (lead) return [...rake, lead];
  return [ends[0]!, ...rake, ends[1]!];
}

/** How long that consist really is, metres. */
export function consistLength(roles: readonly VehicleRole[]): number {
  return roles.reduce((a, r) => a + VEHICLE_M[r], 0);
}

/**
 * Every vehicle placed on the track, nose at `noseKm`.
 *
 * Each comes out as a point carrying the angle its own two ends make — the
 * chord, which is where a rigid vehicle actually sits between two curved
 * rails.
 *
 * Laid out from the nose backwards, because that is the end whose position
 * the model knows. Vehicles that would fall off the start of the route are
 * dropped rather than drawn pointing in an invented direction.
 */
export function trainCars(
  track: Track,
  noseKm: number,
  lengthM: number,
  family: Family,
  livery: string,
  maxCars = 24,
): TrainCarsGeo {
  const features: TrainCarsGeo['features'] = [];
  const nose = Math.min(track.length, noseKm);
  if (nose <= 0) return { type: 'FeatureCollection', features };

  const roles = consist(family, lengthM, maxCars);
  let front = nose;

  for (let i = roles.length - 1; i >= 0; i--) {
    const role = roles[i]!;
    const back = front - VEHICLE_M[role] / 1000;
    if (back < 0) break;

    const a = track.at(back);
    const b = track.at(front);
    if (!a || !b) break;

    // The vehicle at the back faces backwards, if it has a front at all. A
    // TGV has a motrice at each end and a multiple unit a cab at each end,
    // and the rear one is turned round — which is what you see on the ground,
    // and what makes a train look like a train rather than like a row of
    // vehicles all chasing the one in front.
    const reversed = i === 0 && (role === 'power' || role === 'emu-cab') && roles.length > 1;

    features.push({
      type: 'Feature',
      properties: {
        icon: `${role}|${livery}`,
        role,
        // The artwork is drawn nose-right, so east is its zero.
        bearing: Track.bearing(a.lat, a.lon, b.lat, b.lon) - 90 + (reversed ? 180 : 0),
        lead: i === roles.length - 1 ? 1 : 0,
        reversed: reversed ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2] },
    });
    front = back;
  }

  return { type: 'FeatureCollection', features };
}
