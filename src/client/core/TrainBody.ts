/**
 * The train as ground geometry: one polygon per car, laid along the track.
 *
 * A marker is a single point with a single angle, which is fine for a dot but
 * wrong once the train is drawn at its real length. A 200 m TGV on the curve
 * into a station spans a noticeable arc — drawn as one rigid rectangle it
 * leaves the rails at both ends. Real cars are rigid but the couplings are
 * not, so a train on a curve is a chain of straight bodies, each at its own
 * angle. That is exactly what this builds: each car takes its bearing from
 * its own two ends on the centreline, and the set of them articulates round
 * the bend the way the real thing does.
 *
 * Being map geometry rather than a DOM element also means it scales with the
 * zoom for free, and sits under labels instead of over them.
 */

import { Track } from './Track.ts';
import type { Family, PolygonGeom, TrainBodyGeo } from '../../shared/types.ts';
import type { Feature } from '../../shared/types.ts';

/** Nominal car length, metres — between a TGV Duplex car and a Corail coach. */
const CAR_M = 24;

/** Metres of latitude per degree; near enough over a train's length. */
const M_PER_DEG = 111_320;

export interface Corner {
  lat: number;
  lon: number;
}

/** Shift a point by a distance in metres along a bearing. */
function offset(lat: number, lon: number, bearing: number, metres: number): Corner {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / M_PER_DEG;
  const dLon = (metres * Math.sin(rad)) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * How many cars to draw for a train of this length.
 *
 * Capped: past a couple of dozen the divisions are closer together than the
 * body is wide and it reads as hatching rather than as a train.
 */
export function carCount(lengthM: number): number {
  return Math.max(2, Math.min(24, Math.round(lengthM / CAR_M)));
}

/**
 * One car: a rectangle, or a pentagon when it carries the nose.
 *
 * The corners come from the car's own ends rather than from the track's
 * bearing at its centre, so a car on a curve sits on the chord — which is
 * where a rigid vehicle actually sits between two curved rails.
 */
function car(
  track: Track,
  backKm: number,
  frontKm: number,
  halfW: number,
  noseM: number,
): Corner[] | null {
  const back = track.at(backKm);
  const front = track.at(frontKm);
  if (!back || !front) return null;

  const axis = Track.bearing(back.lat, back.lon, front.lat, front.lon);
  const left = axis - 90;
  const right = axis + 90;

  // Walked as a ring: down the left flank, across the front, back up the right.
  const taper = noseM > 0 ? track.at(Math.max(backKm, frontKm - noseM / 1000)) : null;
  const shoulder = taper ?? front;

  return [
    offset(back.lat, back.lon, left, halfW),
    offset(shoulder.lat, shoulder.lon, left, halfW),
    // The tip is on the centreline itself: that is what makes it a point.
    ...(taper ? [{ lat: front.lat, lon: front.lon }] : []),
    offset(shoulder.lat, shoulder.lon, right, halfW),
    offset(back.lat, back.lon, right, halfW),
  ];
}

/**
 * The whole train, nose at `noseKm`, as GeoJSON ready for a MapLibre source.
 *
 * The train is clipped to the route: near the start of a journey the tail
 * would hang off the end of the drawn line, and a body drawn there would be
 * pointing in an invented direction.
 */
export function trainBody(
  track: Track,
  noseKm: number,
  lengthM: number,
  widthM: number,
  family: Family,
): TrainBodyGeo {
  const halfW = widthM / 2;
  const tailKm = Math.max(0, noseKm - lengthM / 1000);
  const nose = Math.min(track.length, noseKm);
  const span = nose - tailKm;

  const features: Feature<PolygonGeom, { lead: 0 | 1; family: Family }>[] = [];
  if (span > 0) {
    const n = carCount(span * 1000);
    // A power car's nose, only on the high-speed sets; the rest are blunt.
    const noseM = family === 'tgv' ? Math.min(12, (span * 1000) / n / 2) : 0;

    for (let i = 0; i < n; i++) {
      // A small gap at each coupling, so the divisions read at a glance.
      const gap = span / n / 12;
      const back = tailKm + (span / n) * i + gap / 2;
      const front = tailKm + (span / n) * (i + 1) - gap / 2;
      const ring = car(track, back, front, halfW, i === n - 1 ? noseM : 0);
      if (!ring) continue;
      features.push({
        type: 'Feature',
        properties: { lead: i === n - 1 ? (1 as const) : (0 as const), family },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              ...ring.map((c): [number, number] => [c.lon, c.lat]),
              [ring[0]!.lon, ring[0]!.lat] as [number, number],
            ],
          ],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
