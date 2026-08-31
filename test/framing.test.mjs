// How close the map sits to a train.
//
// This exists because of a report that the train did not move on the map even
// though the readout said 100 km/h. It was moving — the motion model was
// advancing it correctly — but the old zoom rule widened the view at very
// nearly the rate the train accelerated, so the two cancelled and every train
// at every speed crossed the screen at about 1.4 pixels a second. That reads
// as stationary.
//
// The property worth holding is therefore not about zoom numbers at all: it
// is that the train visibly moves, whatever it is doing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MAX_ZOOM, MIN_ZOOM, SCREEN_PX_PER_SEC, metresPerPixelAt, zoomForSpeed } = await import(
  path.join(ROOT, 'src/client/core/Framing.ts')
);

/** Pixels a second the train appears to move at, at its chosen zoom. */
const apparent = (kmh) => kmh / 3.6 / metresPerPixelAt(zoomForSpeed(kmh));

const SPEEDS = [30, 50, 80, 100, 140, 160, 200, 250, 300, 320];

test('a moving train visibly moves, at every speed', () => {
  // The whole point. Anything under a couple of pixels a second is a map that
  // looks frozen, which is what was reported.
  for (const kmh of SPEEDS) {
    assert.ok(apparent(kmh) >= 4, `${kmh} km/h: ${apparent(kmh).toFixed(1)} px/s`);
  }
});

test('and it does not shoot off the screen either', () => {
  // Fast enough to see, slow enough to watch.
  for (const kmh of SPEEDS) {
    assert.ok(apparent(kmh) <= 20, `${kmh} km/h: ${apparent(kmh).toFixed(1)} px/s`);
  }
});

test('the apparent speed is about the same whatever the train is doing', () => {
  // This is deliberate: the view is chosen so the train reads the same way at
  // 80 as at 300. What was wrong before was the value it settled on, not the
  // idea of settling on one.
  const rates = SPEEDS.filter((k) => zoomForSpeed(k) > MIN_ZOOM && zoomForSpeed(k) < MAX_ZOOM).map(
    apparent,
  );
  for (const r of rates) assert.ok(Math.abs(r - SCREEN_PX_PER_SEC) < 0.1, `${r}`);
});

test('the old rule would fail the test above', () => {
  // Kept as the thing that was actually wrong: zoom out by 0.8 of a level per
  // doubling of speed and a 100 km/h train crawls at 1.4 px/s.
  const old = (kmh) => {
    if (!kmh) return 13.5;
    const z = 13 - Math.log2(Math.max(25, kmh) / 25) * 0.8;
    return Math.max(9.8, Math.min(13.5, z));
  };
  const oldApparent = (kmh) => kmh / 3.6 / metresPerPixelAt(old(kmh));
  assert.ok(oldApparent(100) < 2, `${oldApparent(100).toFixed(2)} px/s`);
  // And barely changed however fast the train went, which is the giveaway.
  assert.ok(Math.abs(oldApparent(300) - oldApparent(50)) < 1, 'speed made almost no difference');
});

test('a faster train still gets a wider view', () => {
  // The original reason for tying zoom to speed: a fast train's position is
  // less certain, and a tight view on one implies a precision that is not
  // there. That is kept.
  for (let i = 1; i < SPEEDS.length; i++) {
    assert.ok(
      zoomForSpeed(SPEEDS[i]) <= zoomForSpeed(SPEEDS[i - 1]),
      `${SPEEDS[i]} km/h should not be closer than ${SPEEDS[i - 1]}`,
    );
  }
});

test('a stopped train is shown close, and nothing divides by zero', () => {
  const z = zoomForSpeed(0);
  assert.ok(z >= 14 && z <= MAX_ZOOM, `${z}`);
  assert.ok(Number.isFinite(z));
});

test('the zoom stays within what the map can honestly show', () => {
  for (const kmh of [0, 1, 5, ...SPEEDS, 500, 1000]) {
    const z = zoomForSpeed(kmh);
    assert.ok(z >= MIN_ZOOM && z <= MAX_ZOOM, `${kmh} km/h gave ${z}`);
    assert.ok(Number.isFinite(z), `${kmh} km/h gave ${z}`);
  }
});

test('the scale matches MapLibre 512-pixel tiles, not the 256 scheme', () => {
  // Getting this wrong by the factor of two is what drew every vehicle at
  // half its length once before.
  assert.ok(Math.abs(metresPerPixelAt(0) - 78271.5 * Math.cos((47 * Math.PI) / 180)) < 1);
  assert.ok(Math.abs(metresPerPixelAt(1) - metresPerPixelAt(0) / 2) < 0.01);
});

test('the map view uses this rule rather than one of its own', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(path.join(ROOT, 'src/client/components/MapView.ts'), 'utf8');
  assert.match(src, /from '\.\.\/core\/Framing\.ts'/, 'MapView should import it');
  // And not carry a second copy that could drift from this one.
  assert.ok(!/13 - Math\.log2/.test(src), 'the old formula is still in MapView');
});
