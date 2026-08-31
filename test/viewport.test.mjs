// When the map should pan after the train.
//
// This came from the map wandering off the train while zoomed in. Two things
// were wrong: it recentred on the position the server last reported rather
// than the one the train is drawn at — a difference of kilometres between
// refreshes at line speed — and nothing brought it back between refreshes at
// all. This is the second half: the rule for when chasing is warranted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { KEEP, leadPoint, outsideMiddle } = await import(
  path.join(ROOT, 'src/client/core/Viewport.ts'),
);

const W = 400;
const H = 800;

test('a train in the middle of the view is left alone', () => {
  // Panning at every opportunity is what makes a map feel like it is fighting
  // you, so the middle of the screen is a no-go zone for the camera.
  assert.equal(outsideMiddle(W / 2, H / 2, W, H), false);
  assert.equal(outsideMiddle(W / 2 + 10, H / 2 - 20, W, H), false);
});

test('a train at the edge of the view is chased', () => {
  assert.equal(outsideMiddle(2, H / 2, W, H), true, 'off to the left');
  assert.equal(outsideMiddle(W - 2, H / 2, W, H), true, 'off to the right');
  assert.equal(outsideMiddle(W / 2, 2, W, H), true, 'off the top');
  assert.equal(outsideMiddle(W / 2, H - 2, W, H), true, 'off the bottom');
});

test('a train off the screen entirely is chased', () => {
  // Which is where it ended up: at 300 km/h it crosses a zoomed-in view in a
  // couple of seconds and then sat outside it until the next data refresh.
  assert.equal(outsideMiddle(-500, H / 2, W, H), true);
  assert.equal(outsideMiddle(W / 2, H * 3, W, H), true);
});

test('the boundary is where the box says it is', () => {
  // Just inside and just outside the middle band, on both axes.
  const mx = (W * (1 - KEEP)) / 2;
  assert.equal(outsideMiddle(mx + 1, H / 2, W, H), false);
  assert.equal(outsideMiddle(mx - 1, H / 2, W, H), true);
  const my = (H * (1 - KEEP)) / 2;
  assert.equal(outsideMiddle(W / 2, my + 1, W, H), false);
  assert.equal(outsideMiddle(W / 2, my - 1, W, H), true);
});

test('the box is a decent share of the screen, not a pinhole', () => {
  // Too small and the map twitches after the train constantly; too large and
  // it only reacts once the train has already gone.
  assert.ok(KEEP > 0.4 && KEEP < 0.8, `${KEEP}`);
});

test('the box scales with the view, so it works on a phone', () => {
  // A narrow screen gets a proportionally narrow band, not the same pixels.
  const phone = { w: 360, h: 640 };
  const desk = { w: 1400, h: 900 };
  const atQuarter = (v) => outsideMiddle(v.w * 0.25, v.h / 2, v.w, v.h);
  assert.equal(atQuarter(phone), atQuarter(desk), 'the same relative spot decides the same way');
});

test('a view with no size never asks for a pan', () => {
  // The map panel is measured as zero while the tab is hidden, and panning on
  // that would move the camera somewhere arbitrary before anyone looked.
  assert.equal(outsideMiddle(0, 0, 0, 0), false);
  assert.equal(outsideMiddle(50, 50, 0, 600), false);
  assert.equal(outsideMiddle(50, 50, 600, 0), false);
});

// ------------------------------------------------------ aiming ahead of it ---

const M = 111320;
const apart = (a, b, lat) => Math.hypot((b[0] - a[0]) * M * Math.cos((lat * Math.PI) / 180), (b[1] - a[1]) * M);

test('the camera is aimed where the train will be, not where it is', () => {
  // Panning takes time and a fast train covers ground while it runs. Aim at
  // where it is and every pan lands behind it — which is how a TGV walked to
  // the edge of the screen and out of view however often the camera chased.
  const [lon, lat] = leadPoint(1.38, 47.28, 0, 300, 0.6);
  assert.ok(apart([1.38, 47.28], [lon, lat], 47.28) > 45, 'should lead by tens of metres');
  assert.ok(lat > 47.28, 'northbound, so ahead is north');
});

test('it leads by exactly the distance the train covers', () => {
  // 300 km/h is 83.3 m/s, so 0.6 s is 50 m.
  const p = leadPoint(1.38, 47.28, 0, 300, 0.6);
  assert.ok(Math.abs(apart([1.38, 47.28], p, 47.28) - 50) < 1, `${apart([1.38, 47.28], p, 47.28)}`);
});

test('it leads along the heading, whichever way that is', () => {
  const east = leadPoint(1.38, 47.28, 90, 300, 0.6);
  assert.ok(east[0] > 1.38 && Math.abs(east[1] - 47.28) < 1e-6, 'due east');
  const south = leadPoint(1.38, 47.28, 180, 300, 0.6);
  assert.ok(south[1] < 47.28, 'due south');
});

test('a slow train is barely led at all', () => {
  // The correction should be proportional: it exists to cancel the lag, not
  // to throw the camera down the line.
  const slow = apart([1.38, 47.28], leadPoint(1.38, 47.28, 0, 30, 0.6), 47.28);
  const fast = apart([1.38, 47.28], leadPoint(1.38, 47.28, 0, 300, 0.6), 47.28);
  assert.ok(fast > slow * 9, `${fast.toFixed(1)} against ${slow.toFixed(1)}`);
});

test('a stopped train, or one with no heading, is aimed at directly', () => {
  assert.deepEqual(leadPoint(1.38, 47.28, 0, 0, 0.6), [1.38, 47.28]);
  assert.deepEqual(leadPoint(1.38, 47.28, null, 300, 0.6), [1.38, 47.28]);
  assert.deepEqual(leadPoint(1.38, 47.28, 0, 300, 0), [1.38, 47.28]);
});

test('the lead cancels the lag it exists for', () => {
  // The check that matters: after a pan of `d` seconds aimed at the lead
  // point, the train should be where the camera is looking.
  const d = 0.6;
  const kmh = 300;
  const aim = leadPoint(1.38, 47.28, 0, kmh, d);
  // Where the train actually gets to in that time.
  const arrived = leadPoint(1.38, 47.28, 0, kmh, d);
  assert.ok(apart(aim, arrived, 47.28) < 0.5, 'the pan lands on the train');
});
