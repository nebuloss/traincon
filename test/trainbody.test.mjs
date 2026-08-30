// The train drawn on the ground, car by car.
//
// The point of drawing it this way rather than as a rotated rectangle is that
// a 200 m train on the approach to a station is on a curve, and a rigid box
// laid over a curve leaves the rails at both ends. These check the thing that
// justifies the complexity: that the cars follow the track, and that each one
// still looks like a car.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Track } = await import(path.join(ROOT, 'src/client/core/Track.ts'));
const { carCount, trainBody } = await import(path.join(ROOT, 'src/client/core/TrainBody.ts'));

const LAT0 = 44.826; // Bordeaux, near enough for the scale factors.
const LON0 = -0.556;
const KM_PER_DEG = 111.32;

/** A dead straight track running north, `km` long. */
function straight(km) {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([LON0, LAT0 + (km * (i / 40)) / KM_PER_DEG]);
  return new Track(pts);
}

/** A quarter circle of the given radius, the sort of curve a station throat has. */
function curve(radiusKm) {
  const pts = [];
  for (let i = 0; i <= 90; i++) {
    const th = (i * Math.PI) / 180;
    pts.push([
      LON0 + (radiusKm * Math.sin(th)) / (KM_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)),
      LAT0 + (radiusKm * (1 - Math.cos(th))) / KM_PER_DEG,
    ]);
  }
  return new Track(pts);
}

const metres = (a, b) => {
  const dLat = (b[1] - a[1]) * KM_PER_DEG * 1000;
  const dLon = (b[0] - a[0]) * KM_PER_DEG * 1000 * Math.cos((LAT0 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The axis of a four-cornered car: back edge centre to front edge centre. */
function axisDeg(feature) {
  const ring = feature.geometry.coordinates[0];
  const back = mid(ring[0], ring[ring.length - 2]);
  const front = mid(ring[1], ring[2]);
  return (Math.atan2(front[0] - back[0], front[1] - back[1]) * 180) / Math.PI;
}

test('a train is divided into something like real cars', () => {
  assert.equal(carCount(200), 8); // a TGV rake, near enough
  assert.equal(carCount(80), 3); // a regional unit
  assert.ok(carCount(10) >= 2, 'never a single undivided blob');
  assert.ok(carCount(5000) <= 24, 'and never hatching');
});

test('the body is laid along the track, not across it', () => {
  const track = straight(10);
  const body = trainBody(track, 5, 200, 2.9, 'ter');
  assert.ok(body.features.length >= 2);
  // Due north, and every car agrees.
  for (const f of body.features) assert.ok(Math.abs(axisDeg(f)) < 1, 'car points north');
});

test('the whole train is as long as it should be', () => {
  const track = straight(10);
  const body = trainBody(track, 5, 200, 2.9, 'ter');
  const rings = body.features.map((f) => f.geometry.coordinates[0]);
  const tail = mid(rings[0][0], rings[0][rings[0].length - 2]);
  const last = rings[rings.length - 1];
  const nose = mid(last[1], last[2]);
  assert.ok(Math.abs(metres(tail, nose) - 200) < 15, `${metres(tail, nose).toFixed(0)} m`);
});

test('the body is as wide as a rail vehicle', () => {
  const ring = trainBody(straight(10), 5, 200, 2.9, 'ter').features[0].geometry.coordinates[0];
  // Corner 0 and the last real corner are the two back corners.
  const across = metres(ring[0], ring[ring.length - 2]);
  assert.ok(Math.abs(across - 2.9) < 0.3, `${across.toFixed(2)} m across`);
});

test('on a curve the cars turn with the track', () => {
  // This is the whole reason the train is geometry and not an icon.
  const track = curve(0.6);
  const nose = Math.min(track.length, 1.0);
  const body = trainBody(track, nose, 200, 2.9, 'ter');
  const first = axisDeg(body.features[0]);
  const last = axisDeg(body.features[body.features.length - 1]);
  // 200 m of train on a 600 m radius sweeps about 19°.
  const swept = Math.abs(last - first);
  assert.ok(swept > 10 && swept < 30, `swept ${swept.toFixed(1)}°`);
});

test('no car strays from the rails on a curve', () => {
  // A single rigid rectangle over this arc would stand about 8 m off the
  // centreline at its ends — more than a track's width from where it belongs.
  const track = curve(0.6);
  const body = trainBody(track, 1.0, 200, 2.9, 'ter');
  let worst = 0;
  for (const f of body.features) {
    const ring = f.geometry.coordinates[0];
    for (const [lon, lat] of ring.slice(0, -1)) {
      const on = track.at(track.distanceAt(lat, lon));
      worst = Math.max(worst, metres([lon, lat], [on.lon, on.lat]));
    }
  }
  // Half a body width plus the sagitta of one car, not of the whole train.
  assert.ok(worst < 3, `worst corner ${worst.toFixed(2)} m off the line`);
});

test('a high-speed set gets a pointed nose, a regional one a blunt end', () => {
  const tgv = trainBody(straight(10), 5, 200, 2.9, 'tgv').features;
  const ter = trainBody(straight(10), 5, 200, 2.9, 'ter').features;
  const lead = (fs) => fs[fs.length - 1].geometry.coordinates[0].length;
  assert.equal(lead(tgv), 6, 'five corners and the closing point');
  assert.equal(lead(ter), 5, 'four corners and the closing point');
  // And only the leading car is shaped: the rest are plain.
  assert.equal(tgv[0].geometry.coordinates[0].length, 5);
});

test('only the leading car is flagged as such', () => {
  const fs = trainBody(straight(10), 5, 200, 2.9, 'tgv').features;
  assert.equal(fs.filter((f) => f.properties.lead === 1).length, 1);
  assert.equal(fs[fs.length - 1].properties.lead, 1);
});

test('a train just starting out is not drawn off the end of its route', () => {
  // 50 m into the journey, a 200 m train has no route behind it to lie on.
  const track = straight(10);
  const body = trainBody(track, 0.05, 200, 2.9, 'ter');
  for (const f of body.features) {
    for (const [, lat] of f.geometry.coordinates[0]) {
      assert.ok(lat >= LAT0 - 1e-6, 'no car behind the start of the line');
    }
  }
});

test('a train at the very start of the route draws nothing rather than nonsense', () => {
  assert.equal(trainBody(straight(10), 0, 200, 2.9, 'ter').features.length, 0);
});

test('the polygons are closed rings', () => {
  for (const f of trainBody(straight(10), 5, 200, 2.9, 'tgv').features) {
    const ring = f.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  }
});

test('a coupled 400 m set is drawn twice as long as one unit', () => {
  const track = straight(10);
  const one = trainBody(track, 5, 200, 2.9, 'tgv');
  const two = trainBody(track, 5, 400, 2.9, 'tgv');
  assert.ok(two.features.length > one.features.length);
});
