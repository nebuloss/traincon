// Putting the train on the rails that are drawn under it.
//
// The train is placed along SNCF Réseau's network geometry; the track beneath
// it is drawn from OpenStreetMap. Both are honest, and they mostly agree — a
// median of 3 m apart, measured on one route — but the SNCF vertices are
// sparse in places, a tenth of that route's segments running over 460 m. A
// straight chord that long cuts the corner: 414 m across an 800 m radius sits
// 27 m inside it, which is a train drawn clearly beside its own rails.
//
// Curving the route through its own vertices was tried and measured worse, so
// this moves the train sideways onto the survey that is already on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MAX_BEARING_GAP, MAX_SNAP_M, headingGap, snapToTrack } = await import(
  path.join(ROOT, 'src/client/core/TrackSnap.ts')
);

const LAT = 47.28;
const LON = 1.38;
const M = 111320;
const KX = M * Math.cos((LAT * Math.PI) / 180);
/** A point `east`/`north` metres from the reference. */
const at = (east, north) => [LON + east / KX, LAT + north / M];
/** A straight track running due north through the reference point. */
const northward = [[at(0, -500), at(0, 500)]];
/** One running due east. */
const eastward = [[at(-500, 0), at(500, 0)]];

const metresApart = (p, q) => Math.hypot((q[0] - p[0]) * KX, (q[1] - p[1]) * M);

test('a train beside the track is moved onto it', () => {
  // 20 m east of a track running north, heading north.
  const hit = snapToTrack(...at(20, 0), 0, northward);
  assert.ok(hit, 'should snap');
  assert.ok(Math.abs(hit.movedM - 20) < 0.5, `${hit.movedM} m`);
  assert.ok(metresApart([hit.lon, hit.lat], at(0, 0)) < 0.5, 'lands on the track');
});

test('it moves sideways, not along', () => {
  // The along-track position is the model's answer and is not second-guessed.
  const hit = snapToTrack(...at(15, 120), 0, northward);
  assert.ok(hit);
  assert.ok(Math.abs(metresApart([hit.lon, hit.lat], at(0, 120))) < 0.5, 'same distance along');
});

test('a train already on the track is left where it is', () => {
  const hit = snapToTrack(...at(0, 0), 0, northward);
  assert.ok(hit);
  assert.ok(hit.movedM < 0.001, `moved ${hit.movedM} m for nothing`);
});

test('a track too far away is not the one the train is on', () => {
  // Beyond the limit this is guessing, and a wrong guess puts the train on
  // the wrong railway.
  assert.equal(snapToTrack(...at(MAX_SNAP_M + 5, 0), 0, northward), null);
  assert.ok(snapToTrack(...at(MAX_SNAP_M - 5, 0), 0, northward), 'just inside is fine');
});

test('a track pointing the wrong way is rejected', () => {
  // A line crossing at right angles is a different railway, however close.
  assert.equal(snapToTrack(...at(0, 5), 0, eastward), null, 'crossing track');
  assert.ok(snapToTrack(...at(0, 5), 90, eastward), 'the same track, going along it');
});

test('a siding trailing in at a shallow angle is still rejected past the limit', () => {
  const angled = [[at(-500, -500 * Math.tan((50 * Math.PI) / 180)), at(500, 500)]];
  // 45 degrees away, which is past the tolerance.
  assert.equal(snapToTrack(...at(0, 0), 0, angled, 100), null);
});

test('the direction comes back with the position', () => {
  // Moving a vehicle onto the rails but leaving it pointing along the chord
  // it came from would sit it on the track at an angle to it — worse than
  // leaving it alone.
  const hit = snapToTrack(...at(20, 0), 5, northward);
  assert.ok(hit);
  assert.ok(Math.abs(hit.bearing) < 1 || Math.abs(hit.bearing - 360) < 1, `${hit.bearing}`);
});

test('the direction agrees with the way the train is going', () => {
  // A rail has no front: the segment may be drawn against the train. The
  // answer must follow the train, not the draughtsman. Getting this backwards
  // turns every vehicle around.
  const south = snapToTrack(...at(20, 0), 180, northward);
  assert.ok(south, 'a southbound train on the same track');
  assert.ok(Math.abs(south.bearing - 180) < 1, `${south.bearing} for a southbound train`);

  const north = snapToTrack(...at(20, 0), 0, northward);
  assert.ok(Math.abs(north.bearing % 360) < 1, `${north.bearing} for a northbound train`);
});

test('a train between two parallel tracks takes the nearer one', () => {
  // A double-track line drawn as two ways, 4 m apart as they really are.
  const pair = [
    [at(-2, -500), at(-2, 500)],
    [at(2, -500), at(2, 500)],
  ];
  const west = snapToTrack(...at(-6, 0), 0, pair);
  assert.ok(metresApart([west.lon, west.lat], at(-2, 0)) < 0.2, 'the western rail');
  const east = snapToTrack(...at(6, 0), 0, pair);
  assert.ok(metresApart([east.lon, east.lat], at(2, 0)) < 0.2, 'the eastern rail');
});

test('with no track loaded it declines rather than inventing one', () => {
  assert.equal(snapToTrack(...at(0, 0), 0, []), null);
  assert.equal(snapToTrack(...at(0, 0), 0, [[]]), null);
  assert.equal(snapToTrack(...at(0, 0), 0, [[at(0, 0)]]), null, 'a line with one point');
});

test('an unknown heading skips the direction check rather than failing', () => {
  // Better a train on the right rails pointing an unknown way than a train
  // beside them.
  const hit = snapToTrack(...at(10, 0), null, northward);
  assert.ok(hit, 'should still snap');
});

test('degenerate segments do not divide by zero', () => {
  const doubled = [[at(0, 0), at(0, 0), at(0, 100)]];
  const hit = snapToTrack(...at(10, 50), 0, doubled);
  assert.ok(hit && Number.isFinite(hit.lon) && Number.isFinite(hit.lat));
});

test('headings are compared without a front end', () => {
  assert.equal(headingGap(0, 180), 0, 'a rail pointing north is the same rail as south');
  assert.equal(headingGap(10, 190), 0);
  assert.equal(headingGap(0, 90), 90);
  assert.ok(headingGap(0, 35) === 35 && MAX_BEARING_GAP > 35, 'a curve may be a few degrees out');
});
