// Putting the train on the rails that are drawn under it — the right ones.
//
// The train is placed along SNCF Réseau's network geometry; the track beneath
// it is drawn from OpenStreetMap. They mostly agree, but the SNCF vertices are
// sparse in places and a long chord cuts the corner of a curve: 414 m across
// an 800 m radius sits 27 m inside it, which is a train drawn beside its own
// rails.
//
// Moving it onto the nearest track fixed that and broke something else. On a
// double-track line the two running lines are about four and a half metres
// apart and both point the same way, so "nearest" alternated between them as
// the centreline wandered and the train appeared to change track constantly.
// Which track a train uses is not a matter of proximity: French trains run on
// the left. That is the rule here, and being deterministic it cannot flicker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MAX_BEARING_GAP, MAX_SNAP_M, STICKY_M, headingGap, snapToLine, snapToTrack } = await import(
  path.join(ROOT, 'src/core/TrackSnap.ts')
);

const LAT = 47.28;
const LON = 1.38;
const M = 111320;
const KX = M * Math.cos((LAT * Math.PI) / 180);
/** A point `east`/`north` metres from the reference. */
const at = (east, north) => [LON + east / KX, LAT + north / M];
const apart = (p, q) => Math.hypot((q[0] - p[0]) * KX, (q[1] - p[1]) * M);

const line = (key, ...pts) => ({ key, points: pts });
/** A single track running due north through the reference point. */
const single = [line('one', at(0, -500), at(0, 500))];
/** A double-track railway running north–south, the rails 4.5 m apart. */
const double = [
  line('west', at(-2.25, -500), at(-2.25, 500)),
  line('east', at(2.25, -500), at(2.25, 500)),
];

// ------------------------------------------------------ the side to be on ---

test('a northbound train takes the western track, because trains run on the left', () => {
  // Heading north, left is west. This is the whole rule.
  const hit = snapToTrack(...at(0, 0), 0, double);
  assert.equal(hit.key, 'west', 'left of north is west');
});

test('a southbound train on the same railway takes the eastern one', () => {
  // Left of south is east. The two directions use different rails, which is
  // exactly what "nearest" could never express.
  const hit = snapToTrack(...at(0, 0), 180, double);
  assert.equal(hit.key, 'east');
});

test('the side wins even when the other track is nearer', () => {
  // The centreline does not sit midway between the rails everywhere, and
  // whichever happens to be closer is not the one the train is on.
  const hit = snapToTrack(...at(1.9, 0), 0, double);
  assert.equal(hit.key, 'west', 'nearer is not the same as correct');
  assert.ok(hit.movedM > 4, `moved ${hit.movedM.toFixed(1)} m across to it`);
});

test('an eastbound train takes the northern track', () => {
  const eastWest = [
    line('north', at(-500, 2.25), at(500, 2.25)),
    line('south', at(-500, -2.25), at(500, -2.25)),
  ];
  assert.equal(snapToTrack(...at(0, 0), 90, eastWest).key, 'north', 'left of east is north');
  assert.equal(snapToTrack(...at(0, 0), 270, eastWest).key, 'south', 'left of west is south');
});

test('the answer does not depend on where the train started', () => {
  // The flicker was the symptom: the same train, a metre either way, chose a
  // different track. A rule that turns on the direction of travel cannot.
  for (const offset of [-2, -1, 0, 1, 2]) {
    assert.equal(snapToTrack(...at(offset, 0), 0, double).key, 'west', `from ${offset} m`);
  }
});

test('a single track is taken whichever way the train is going', () => {
  // With one rail there is no side to be on, and the fallback answers.
  assert.equal(snapToTrack(...at(10, 0), 0, single).key, 'one');
  assert.equal(snapToTrack(...at(10, 0), 180, single).key, 'one');
});

test('where the region runs on the right, the train takes the other track', () => {
  // Alsace-Moselle keeps right — see core/RunningSide. The rule is the same
  // rule, with the side turned over, so a northbound train there takes the
  // eastern rail rather than the western one.
  assert.equal(snapToTrack(...at(0, 0), 0, double, MAX_SNAP_M, null, false).key, 'east');
  assert.equal(snapToTrack(...at(0, 0), 180, double, MAX_SNAP_M, null, false).key, 'west');
  // And the default is still left, so nothing else in France moves.
  assert.equal(snapToTrack(...at(0, 0), 0, double).key, 'west');
});

test('the side still beats proximity when the region runs right', () => {
  // The same guarantee as for left-hand running: the nearer rail is not the
  // one the train is on.
  assert.equal(snapToTrack(...at(-1.9, 0), 0, double, MAX_SNAP_M, null, false).key, 'east');
});

// ---------------------------------------------------------- staying put ---

test('the train stays on the track it is already on, among those on its side', () => {
  // A four-track railway: two roads each way. Which of the pair a train uses
  // is not something this can know, so whichever it was on, it stays on.
  const fourTrack = [
    line('slow west', at(-6.75, -500), at(-6.75, 500)),
    line('fast west', at(-2.25, -500), at(-2.25, 500)),
    line('fast east', at(2.25, -500), at(2.25, 500)),
    line('slow east', at(6.75, -500), at(6.75, 500)),
  ];
  // With nothing to go on, the nearer of the two on the left — the route
  // centreline follows the main running line, so that is the better guess.
  assert.equal(snapToTrack(...at(0, 0), 0, fourTrack).key, 'fast west');

  // A train already over on the slow line stays there rather than being
  // pulled back across every frame.
  assert.equal(snapToTrack(...at(-5, 0), 0, fourTrack, MAX_SNAP_M, 'slow west').key, 'slow west');

  // Worth being exact about what "left" means here: it is left of where the
  // model puts the train, not left of the railway as a whole. So a train the
  // model has placed between the two westbound roads finds the slow one on
  // its left and the fast one on its right, and takes the slow one — with or
  // without a preference. On the double-track case that this exists for, the
  // centreline sits between the pair and the answer is the one you would
  // expect.
  assert.equal(snapToTrack(...at(-4.4, 0), 0, fourTrack).key, 'slow west');
  assert.equal(snapToTrack(...at(-4.4, 0), 0, fourTrack, MAX_SNAP_M, 'fast west').key, 'slow west');
});

test('staying put never overrides the side the train runs on', () => {
  // Preference is a bias among plausible tracks, not a licence to sit on the
  // wrong one. A train that was somehow on the right-hand rail belongs back
  // on the left.
  const hit = snapToTrack(...at(0, 0), 0, double, MAX_SNAP_M, 'east');
  assert.equal(hit.key, 'west', 'the rule wins');
});

test('a preferred track that is no longer there is simply dropped', () => {
  const hit = snapToTrack(...at(0, 0), 0, [double[0]], MAX_SNAP_M, 'east');
  assert.equal(hit.key, 'west');
});

test('the stickiness is about the width of a double-track railway', () => {
  assert.ok(STICKY_M > 2 && STICKY_M < 6, `${STICKY_M} m`);
});

// ------------------------------------------------- the geometry underneath ---

test('a train beside the track is moved onto it, sideways', () => {
  // The reason any of this exists. The along-track position is the model's
  // answer and is not second-guessed.
  const hit = snapToTrack(...at(20, 120), 0, single);
  assert.ok(Math.abs(hit.movedM - 20) < 0.5, `${hit.movedM} m`);
  assert.ok(apart([hit.lon, hit.lat], at(0, 120)) < 0.5, 'same distance along');
});

test('a track too far away is not the one the train is on', () => {
  assert.equal(snapToTrack(...at(MAX_SNAP_M + 5, 0), 0, single), null);
  assert.ok(snapToTrack(...at(MAX_SNAP_M - 5, 0), 0, single), 'just inside is fine');
});

test('a track pointing the wrong way is rejected', () => {
  const across = [line('across', at(-500, 5), at(500, 5))];
  assert.equal(snapToTrack(...at(0, 0), 0, across), null, 'a crossing line is another railway');
  assert.ok(snapToTrack(...at(0, 0), 90, across), 'the same line, going along it');
});

test('the direction comes back, and follows the train not the draughtsman', () => {
  // A rail has no front: the way it happens to be drawn is not the way the
  // train is going. Getting this backwards turns every vehicle round.
  const north = snapToTrack(...at(0, 0), 0, single);
  assert.ok(Math.abs(north.bearing % 360) < 1, `${north.bearing} going north`);
  const south = snapToTrack(...at(0, 0), 180, single);
  assert.ok(Math.abs(south.bearing - 180) < 1, `${south.bearing} going south`);
});

test('with no track loaded it declines rather than inventing one', () => {
  assert.equal(snapToTrack(...at(0, 0), 0, []), null);
  assert.equal(snapToTrack(...at(0, 0), 0, [line('empty')]), null);
  assert.equal(snapToTrack(...at(0, 0), 0, [line('one point', at(0, 0))]), null);
});

test('an unknown heading still puts the train on a rail', () => {
  // Better a train on the right rails pointing an unknown way than a train
  // beside them. With no heading there is no side, so the nearest answers.
  assert.ok(snapToTrack(...at(10, 0), null, single));
});

test('degenerate segments do not divide by zero', () => {
  const doubled = [line('doubled', at(0, 0), at(0, 0), at(0, 100))];
  const hit = snapToTrack(...at(10, 50), 0, doubled);
  assert.ok(hit && Number.isFinite(hit.lon) && Number.isFinite(hit.lat));
});

// ------------------------------------------- putting the rest of it on too ---

test('every vehicle goes on the one line the train was put on', () => {
  // Letting each vehicle choose meant a 200 m set could straddle both running
  // lines at once. snapToLine takes the track as given.
  const chosen = double[0];
  for (const along of [-100, 0, 100]) {
    const hit = snapToLine(...at(3, along), chosen);
    assert.ok(apart([hit.lon, hit.lat], at(-2.25, along)) < 0.3, `at ${along} m`);
  }
});

test('snapToLine does not second-guess the choice', () => {
  // Even from the far side of the other rail, it puts the vehicle on the line
  // it was handed — that decision was made once, at the front of the train.
  const hit = snapToLine(...at(50, 0), double[0]);
  assert.ok(apart([hit.lon, hit.lat], at(-2.25, 0)) < 0.3);
});

test('headings are compared without a front end', () => {
  assert.equal(headingGap(0, 180), 0, 'a rail pointing north is the same rail as south');
  assert.equal(headingGap(0, 90), 90);
  assert.ok(headingGap(0, 35) === 35 && MAX_BEARING_GAP > 35, 'a curve may be a few degrees out');
});
