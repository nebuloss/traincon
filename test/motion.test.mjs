// Reading the motion profile the server sends.
//
// A train does not cover equal ground in equal minutes: it is still
// accelerating out of one station and already braking into the next. The server
// works that curve out once per routed leg — from the line speeds, the rate a
// train gains speed and the rate it loses it — and sends the result in the
// journey payload as a series of equally spaced samples.
//
// This side only reads it. That split is why the drawn train cannot drift from
// the server's answer: the browser is evaluating the server's own curve at a
// finer interval, not approximating it. The sampling half now lives in the Go
// server, in internal/motion, and is tested there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { distanceFraction } = await import(path.join(ROOT, 'src/core/motion.ts'));

/** A leg that covers half its distance in the first tenth of its time. */
const frontLoaded = [0, 0.5, 1];

test('the ends of a leg are its ends', () => {
  // Rounding must not leave a train short of its own terminus, nor start it
  // past its origin.
  assert.equal(distanceFraction(frontLoaded, 0), 0);
  assert.equal(distanceFraction(frontLoaded, 1), 1);
});

test('a moment between two samples is interpolated', () => {
  // Twelve times a second against 129 samples: almost every call lands between
  // two of them, so this is the common case rather than an edge.
  assert.equal(distanceFraction(frontLoaded, 0.25), 0.25);
  assert.equal(distanceFraction(frontLoaded, 0.75), 0.75);
});

test('a profile with a real bend is followed, not straightened', () => {
  // Half the ground covered in the first quarter of the time.
  const profile = [0, 0.5, 0.75, 0.9, 1];
  assert.equal(distanceFraction(profile, 0.25), 0.5);
  assert.equal(distanceFraction(profile, 0.5), 0.75);
});

test('a leg running over its time sits at the end of it', () => {
  // A late train has a time fraction above one, and must not be drawn past its
  // own terminus.
  assert.equal(distanceFraction(frontLoaded, 5), 1);
  assert.equal(distanceFraction(frontLoaded, -5), 0);
});

test('a leg with no profile is read as constant speed', () => {
  // A leg with no routed geometry has no curve to send, and a straight line is
  // the same assumption the rest of the code makes about those.
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(distanceFraction(undefined, f), f);
    assert.equal(distanceFraction([], f), f);
    assert.equal(distanceFraction([0.4], f), f, 'one sample describes nothing');
  }
});

test('progress never goes backwards as time advances', () => {
  // The guarantee the map depends on: a train that is drawn moving must not be
  // drawn moving backwards between two frames.
  const profile = [0, 0.05, 0.2, 0.55, 0.8, 0.95, 1];
  let last = -1;
  for (let f = 0; f <= 1; f += 0.001) {
    const now = distanceFraction(profile, f);
    assert.ok(now >= last, `went backwards at ${f}: ${last} -> ${now}`);
    last = now;
  }
});
