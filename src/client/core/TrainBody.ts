/**
 * The train as ground geometry: the vehicle from directly above, on its track.
 *
 * A marker is a single point with a single angle, which is fine for a dot but
 * wrong once the train is drawn at its real length. A 200 m TGV on the curve
 * into a station spans a noticeable arc — drawn as one rigid rectangle it
 * leaves the rails at both ends. Real cars are rigid but the couplings are
 * not, so a train on a curve is a chain of straight bodies, each at its own
 * angle. That is what this builds, and it is why the drawing is geometry
 * rather than an icon: an icon cannot bend.
 *
 * Within that constraint it is drawn as a plan view rather than as a row of
 * boxes, because from above a train is mostly roof. So each car is a roof
 * panel inset within the livery, with the equipment that sits on it: air
 * conditioning blocks, and pantographs on the powered cars. The leading car
 * has an elliptical nose with the windscreen behind it, the rear of the train
 * is rounded off, and the gangways between cars are drawn as the narrow dark
 * bands they are from overhead.
 *
 * The parts come out as separate features tagged with `part`, and the map
 * styles each one — see MapView.addTrainBody.
 *
 * Every detail is sized as a fraction of the drawn width, not in real metres.
 * The width is inflated at low zoom so the train does not vanish to a hairline
 * (a rail vehicle is 2.9 m across against 200 m long), and details measured in
 * true metres would disappear while the body around them stayed visible.
 */

import { Track } from './Track.ts';
import type { Family, PolygonGeom, TrainBodyGeo, TrainPart } from '../../shared/types.ts';
import type { Feature } from '../../shared/types.ts';

/** Nominal car length, metres — between a TGV Duplex car and a Corail coach. */
const CAR_M = 24;

/** Metres of latitude per degree; near enough over a train's length. */
const M_PER_DEG = 111_320;

/** Points used to draw each curved end. Five is smooth at any zoom this shows at. */
const CURVE_STEPS = 5;

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
export function carCount(lengthM: number, max = 24): number {
  return Math.max(2, Math.min(24, Math.max(2, max), Math.round(lengthM / CAR_M)));
}

/**
 * A shape laid along the track between two points, `half(x)` wide at each
 * station along it.
 *
 * The flanks take their direction from the piece's own two ends rather than
 * from the track's bearing at each point, so a car sits on the chord — which
 * is where a rigid vehicle actually sits between two curved rails.
 */
function shape(
  track: Track,
  backKm: number,
  frontKm: number,
  xs: readonly number[],
  half: (x: number) => number,
): Corner[] | null {
  const back = track.at(backKm);
  const front = track.at(frontKm);
  if (!back || !front) return null;
  if (frontKm <= backKm) return null;

  const axis = Track.bearing(back.lat, back.lon, front.lat, front.lon);

  const left: Corner[] = [];
  const right: Corner[] = [];
  for (const x of xs) {
    const p = track.at(backKm + x / 1000);
    if (!p) continue;
    const w = half(x);
    if (w <= 0.01) {
      // A point: the nose tip. One corner, not two.
      left.push({ lat: p.lat, lon: p.lon });
      continue;
    }
    left.push(offset(p.lat, p.lon, axis - 90, w));
    right.push(offset(p.lat, p.lon, axis + 90, w));
  }
  if (left.length + right.length < 3) return null;
  return [...left, ...right.reverse()];
}

/** Stations along a piece, with extra detail wherever it curves. */
function stations(spanM: number, noseM: number, tailM: number): number[] {
  const xs = new Set<number>([0, spanM]);
  for (let i = 1; i <= CURVE_STEPS; i++) {
    if (tailM > 0) xs.add((tailM * i) / CURVE_STEPS);
    if (noseM > 0) xs.add(spanM - noseM + (noseM * i) / CURVE_STEPS);
  }
  if (tailM > 0) xs.add(tailM);
  if (noseM > 0) xs.add(spanM - noseM);
  return [...xs].filter((x) => x >= 0 && x <= spanM).sort((a, b) => a - b);
}

/**
 * The half-width profile of one car.
 *
 * Both ends are quarter ellipses: the nose comes to a point, while the tail is
 * cut short of one so it rounds off like a rear cab rather than tapering to a
 * second sharp end.
 */
function profile(spanM: number, halfW: number, noseM: number, tailM: number) {
  return (x: number): number => {
    if (noseM > 0 && x > spanM - noseM) {
      const t = Math.min(1, (x - (spanM - noseM)) / noseM);
      return halfW * Math.sqrt(Math.max(0, 1 - t * t));
    }
    if (tailM > 0 && x < tailM) {
      const t = Math.min(1, (tailM - x) / tailM);
      return halfW * Math.sqrt(Math.max(0, 1 - (0.78 * t) ** 2));
    }
    return halfW;
  };
}

/** A plain rectangle along the track — roofs, windscreens, roof equipment. */
function slab(track: Track, backKm: number, frontKm: number, halfW: number): Corner[] | null {
  return shape(track, backKm, frontKm, [0, (frontKm - backKm) * 1000], () => halfW);
}

function feature(ring: Corner[], part: TrainPart, lead: 0 | 1, family: Family) {
  return {
    type: 'Feature' as const,
    properties: { part, lead, family },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          ...ring.map((c): [number, number] => [c.lon, c.lat]),
          [ring[0]!.lon, ring[0]!.lat] as [number, number],
        ],
      ],
    },
  };
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
  maxCars = 24,
): TrainBodyGeo {
  const halfW = widthM / 2;
  const tailKm = Math.max(0, noseKm - lengthM / 1000);
  const nose = Math.min(track.length, noseKm);
  const span = nose - tailKm;

  const features: Feature<PolygonGeom, { part: TrainPart; lead: 0 | 1; family: Family }>[] = [];
  if (span <= 0) return { type: 'FeatureCollection', features };

  // A car shorter than the body is wide draws as a square, which is the one
  // thing this is not meant to look like. The width is inflated at low zoom,
  // so that is reachable: 200 m in eight cars is 25 m each, against a body
  // drawn 30 m wide. Divide into fewer, longer cars instead.
  const roomy = Math.floor((span * 1000) / (widthM * 1.6));
  const n = carCount(span * 1000, Math.min(maxCars, roomy));
  const carKm = span / n;
  const carM = carKm * 1000;
  const push = (ring: Corner[] | null, part: TrainPart, lead: 0 | 1) => {
    if (ring) features.push(feature(ring, part, lead, family));
  };

  // Proportional to the drawn width, so the detail survives the width being
  // inflated for legibility at low zoom.
  const noseM = Math.min(family === 'tgv' ? widthM * 2.4 : widthM * 0.8, carM * 0.5);
  const tailM = Math.min(widthM * 0.7, carM * 0.35);

  for (let i = 0; i < n; i++) {
    // The cars touch. An earlier version left a gap at each coupling, which at
    // this width read as a dashed line rather than as a train; the gangway
    // band below shows the division without breaking the body up.
    const back = tailKm + carKm * i;
    const front = tailKm + carKm * (i + 1);
    const lead = i === n - 1 ? (1 as const) : (0 as const);
    const myNose = lead ? noseM : 0;
    const myTail = i === 0 ? tailM : 0;
    const m = (x: number) => back + x / 1000;

    push(
      shape(track, back, front, stations(carM, myNose, myTail), profile(carM, halfW, myNose, myTail)),
      'body',
      lead,
    );

    // The roof panel: the surface you actually see from above, inset so the
    // livery shows as a border down both sides.
    const roofBack = Math.max(myTail, widthM * 0.3);
    const roofFront = carM - Math.max(myNose, widthM * 0.3);
    if (roofFront > roofBack) push(slab(track, m(roofBack), m(roofFront), halfW * 0.56), 'roof', lead);

    // The gangway to the next car — a narrow dark band across the join.
    if (i < n - 1) {
      push(slab(track, m(carM - widthM * 0.16), m(carM + widthM * 0.16), halfW * 0.44), 'gangway', lead);
    }

    // A windscreen behind the nose, which is what says which way it faces.
    if (lead) push(slab(track, m(carM - noseM * 0.95), m(carM - noseM * 0.3), halfW * 0.6), 'glass', lead);

    // Pantographs on the powered cars — on a high-speed set that is the two
    // ends, otherwise one somewhere in the middle. From above a pantograph is
    // a bar lying across the roof, which is how it is drawn.
    const powered = family === 'tgv' ? lead === 1 || i === 0 : i === Math.floor(n / 2);
    if (powered && roofFront > roofBack) {
      const at = lead ? roofBack + (roofFront - roofBack) * 0.2 : roofBack + (roofFront - roofBack) * 0.62;
      push(slab(track, m(at), m(at + widthM * 0.32), halfW * 0.86), 'panto', lead);
    }

    // Roof kit — the air conditioning and electrical blocks that break up the
    // roofline. Two per car, small, and only where there is room to see them.
    if (roofFront - roofBack > widthM * 1.6) {
      for (const f of [0.34, 0.72]) {
        if (powered && Math.abs(f - 0.62) < 0.2) continue;
        const at = roofBack + (roofFront - roofBack) * f;
        push(slab(track, m(at), m(at + widthM * 0.22), halfW * 0.34), 'kit', lead);
      }
    }
  }

  return { type: 'FeatureCollection', features };
}
