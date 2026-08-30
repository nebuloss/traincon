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
const { KEEP, outsideMiddle } = await import(path.join(ROOT, 'src/client/core/Viewport.ts'));

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
