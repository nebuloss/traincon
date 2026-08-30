// Measuring a route so the map can move a train along it.
//
// The map only had positions twice a minute, so a train sat still and then
// jumped. This advances it along the drawn route at its reported speed in
// between. If the maths is wrong the train slides off the line, or drifts
// ahead of where the server later says it is — both worse than not moving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Track } = await import(path.join(ROOT, 'src/client/core/Track.ts'));

/** A due-east line at latitude 48, in GeoJSON [lon, lat] order. */
function eastward(points, stepDeg = 0.01) {
  return Array.from({ length: points }, (_, i) => [2 + i * stepDeg, 48]);
}

test('the line measures to a plausible length', () => {
  // 0.01° of longitude at 48° N is about 745 m.
  const t = new Track(eastward(11));
  assert.ok(t.length > 7 && t.length < 8, `10 steps measured ${t.length.toFixed(2)} km`);
  assert.equal(t.points, 11);
});

test('a point on the line reports its own distance', () => {
  const t = new Track(eastward(11));
  assert.equal(t.distanceAt(48, 2), 0);
  const mid = t.distanceAt(48, 2.05);
  assert.ok(Math.abs(mid - t.length / 2) < 0.1, `midpoint measured at ${mid.toFixed(2)} km`);
});

test('advancing along the line stays on it', () => {
  const t = new Track(eastward(11));
  for (let d = 0; d <= t.length; d += 0.3) {
    const p = t.at(d);
    assert.ok(Math.abs(p.lat - 48) < 1e-9, `drifted off the line at ${d} km`);
    assert.ok(p.lon >= 2 && p.lon <= 2.1 + 1e-9);
  }
});

test('distance and position round-trip', () => {
  const t = new Track(eastward(21));
  for (const d of [0, 1, 5, 10, t.length]) {
    const p = t.at(d);
    const back = t.distanceAt(p.lat, p.lon);
    // distanceAt snaps to the nearest vertex, so allow one segment of slack.
    assert.ok(Math.abs(back - d) < 0.8, `${d} km came back as ${back.toFixed(2)}`);
  }
});

test('it does not run off either end', () => {
  const t = new Track(eastward(11));
  const start = t.at(-50);
  const end = t.at(t.length + 50);
  assert.ok(Math.abs(start.lon - 2) < 1e-9, 'clamped to the start');
  assert.ok(Math.abs(end.lon - 2.1) < 1e-6, 'clamped to the terminus');
});

test('bearing follows the line', () => {
  const east = new Track(eastward(5));
  assert.ok(Math.abs(east.at(1).bearing - 90) < 1, 'an eastward line should read ~90°');

  const north = new Track(Array.from({ length: 5 }, (_, i) => [2, 48 + i * 0.01]));
  assert.ok(north.at(0.5).bearing < 1 || north.at(0.5).bearing > 359, 'northward should read ~0°');
});

test('walking forward then back gives the same answers', () => {
  // The cursor is kept between calls so an animation costs O(1) per frame; a
  // server correction can move the train backwards and must still be right.
  const t = new Track(eastward(41));
  const forward = [];
  for (let d = 0; d < t.length; d += 0.5) forward.push(t.at(d).lon);

  const backward = [];
  for (let i = forward.length - 1; i >= 0; i--) backward.push(t.at(i * 0.5).lon);
  backward.reverse();

  assert.deepEqual(backward, forward, 'the cursor must rewind, not stick');
});

test('a degenerate route is handled rather than crashing', () => {
  assert.equal(new Track([]).at(0), null);
  assert.equal(new Track([[2, 48]]).at(0), null, 'one point is not a line');
  assert.equal(new Track([]).length, 0);
});

test('dead reckoning lands where the speed says it should', () => {
  // 300 km/h for 30 seconds is 2.5 km — the gap between two server updates.
  const t = new Track(eastward(101));
  const from = 1.0;
  const after = t.at(from + 300 * (30 / 3600));
  const travelled = t.distanceAt(after.lat, after.lon);
  assert.ok(
    Math.abs(travelled - (from + 2.5)) < 0.8,
    `expected ~3.5 km along, got ${travelled.toFixed(2)}`,
  );
});
