// Absorbing position corrections by adjusting speed.
//
// The map recomputes position from the shared motion model many times a
// second, so it already agrees with the server between refreshes. What it
// cannot avoid is the model's input changing: a refresh that revises a leg's
// times moves the modelled position, and following that directly makes the
// train teleport — backwards if the delay grew, which reads as the train
// physically reversing.
//
// The correction is applied to speed rather than position, so the drawn train
// is always the integral of a plausible speed: continuous by construction, and
// unable to reverse because that speed is never negative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Reckoner } = await import(path.join(ROOT, 'src/client/core/Reckoner.ts'));

/** One frame at the animation's real rate. */
const FRAME = 80;
/** Run `ms` of frames against a fixed target. */
function run(r, target, kmh, ms) {
  const positions = [];
  for (let t = 0; t < ms; t += FRAME) positions.push(r.follow(target, kmh, FRAME));
  return positions;
}

test('the first position is taken as-is', () => {
  const r = new Reckoner();
  assert.equal(r.follow(10, 200, FRAME), 10);
});

test('it converges on a steady model', () => {
  const r = new Reckoner();
  r.follow(10, 200, FRAME);
  run(r, 10.5, 200, 20_000);
  assert.ok(Math.abs(r.current - 10.5) < 0.01, `settled at ${r.current}`);
});

test('catching up is done by running faster, not by jumping', () => {
  const r = new Reckoner();
  r.follow(10, 200, FRAME);

  // The model is 400 m ahead. Each frame must move by something a train could
  // plausibly cover in 80 ms — at most 1.6x of 200 km/h, i.e. 7.1 m.
  const seen = run(r, 10.4, 200, 3000);
  let prev = 10;
  for (const p of seen) {
    const metres = (p - prev) * 1000;
    assert.ok(metres >= -1e-9, `moved backwards by ${(-metres).toFixed(1)} m`);
    assert.ok(metres < 7.2, `covered ${metres.toFixed(1)} m in one frame — a jump`);
    prev = p;
  }
});

test('an overrun is absorbed by slowing down, never by reversing', () => {
  const r = new Reckoner();
  r.follow(10, 250, FRAME);

  // The model says it is 300 m behind what is drawn.
  const seen = run(r, 9.7, 250, 6000);
  let prev = 10;
  for (const p of seen) {
    assert.ok(p >= prev - 1e-9, `reversed: ${prev} -> ${p}`);
    prev = p;
  }
  // Slowed, rather than held rigid or run on regardless.
  assert.ok(r.current - 10 < 0.35, 'should have eased off while the model caught up');
});

test('a train the model says is stopped can still be corrected forward', () => {
  // Without a floor on the catch-up speed, a stationary train could never
  // close a gap at all.
  const r = new Reckoner();
  r.follow(10, 0, FRAME);
  run(r, 10.05, 0, 20_000);
  assert.ok(Math.abs(r.current - 10.05) < 0.01, `stuck at ${r.current}`);
});

test('it does not sail past the position it is chasing', () => {
  const r = new Reckoner();
  r.follow(10, 300, FRAME);
  const seen = run(r, 10.2, 300, 20_000);
  for (const p of seen) assert.ok(p <= 10.2 + 1e-9, `overshot to ${p}`);
});

test('a change too large for one journey is taken at once', () => {
  const r = new Reckoner();
  r.follow(10, 200, FRAME);
  // Twenty kilometres: no believable speed closes that, and easing across it
  // would show the train somewhere it is not for minutes.
  assert.equal(r.follow(30, 200, FRAME), 30);
});

test('a moving model is tracked without the drawn train falling behind', () => {
  const r = new Reckoner();
  let modelKm = 10;
  r.follow(modelKm, 180, FRAME);

  // 180 km/h for two minutes, the model advancing every frame as it would.
  for (let t = 0; t < 120_000; t += FRAME) {
    modelKm += 180 * (FRAME / 3_600_000);
    r.follow(modelKm, 180, FRAME);
  }
  assert.ok(Math.abs(r.current - modelKm) < 0.02, `drifted to ${(r.current - modelKm) * 1000} m`);
});

test('successive backward revisions never produce a reversal', () => {
  // The real pattern: a delay grows over several refreshes, each one placing
  // the train behind where it was drawn.
  const r = new Reckoner();
  let last = r.follow(20, 250, FRAME);
  for (let round = 0; round < 10; round++) {
    const target = 20 - round * 0.08;
    for (let t = 0; t < 30_000; t += FRAME) {
      const now = r.follow(target, 250, FRAME);
      assert.ok(now >= last - 1e-9, `reversed at round ${round}: ${last} -> ${now}`);
      last = now;
    }
  }
});

test('reset makes the next position a fresh start', () => {
  const r = new Reckoner();
  r.follow(120, 200, FRAME);
  r.reset();
  assert.equal(r.current, null);
  assert.equal(r.follow(3, 200, FRAME), 3);
});

// ── the catch-up is still bound by what the train can do ─────────────────────
//
// The reported speed is already held to the line and the stock, but the
// catch-up allowance sat on top of it, so a TER reported at its 160 ceiling
// was drawn covering ground at 256 to close a gap. Being late is not a
// dispensation.

/** Peak drawn speed, km/h, inferred from how far it actually moved. */
function fastestKmh(r, target, kmh, ms, maxKmh) {
  let prev = r.current ?? 0;
  let peak = 0;
  for (let t = 0; t < ms; t += FRAME) {
    const now = r.follow(target, kmh, FRAME, maxKmh);
    peak = Math.max(peak, (now - prev) / (FRAME / 3_600_000));
    prev = now;
  }
  return peak;
}

test('a late TER does not close the gap at 256 km/h', () => {
  const r = new Reckoner();
  r.follow(10, 160, FRAME, 160);
  // A revision puts the model 2 km ahead: the gap the catch-up exists for.
  const peak = fastestKmh(r, 12, 160, 4000, 160);
  assert.ok(peak <= 160 + 1e-6, `drew ${peak.toFixed(0)} km/h on a 160 ceiling`);
});

test('without a ceiling the old behaviour is what it was', () => {
  // Guards the test above against passing for the wrong reason: the same gap,
  // with no limit given, still uses the 1.6x catch-up allowance.
  const r = new Reckoner();
  r.follow(10, 160, FRAME);
  const peak = fastestKmh(r, 12, 160, 4000, Infinity);
  assert.ok(peak > 200, `catch-up allowance gone: only ${peak.toFixed(0)} km/h`);
});

test('a stopped train can still be nudged, but not past the line', () => {
  // MIN_CATCHUP_KMH exists so a train the model says is stopped can still be
  // corrected. It must not become a way around a slow line.
  const r = new Reckoner();
  r.follow(10, 0, FRAME, 20);
  const peak = fastestKmh(r, 10.5, 0, 4000, 20);
  assert.ok(peak > 0, 'a stopped train can still be corrected');
  assert.ok(peak <= 20 + 1e-6, `drew ${peak.toFixed(0)} km/h on a 20 ceiling`);
});

test('the ceiling never makes the train reverse', () => {
  // The no-reversal guarantee is the one thing that must survive every change.
  const r = new Reckoner();
  let last = r.follow(20, 200, FRAME, 200);
  for (let round = 0; round < 8; round++) {
    const target = 20 - round * 0.05;
    for (let t = 0; t < 10_000; t += FRAME) {
      const now = r.follow(target, 200, FRAME, 200);
      assert.ok(now >= last - 1e-9, `reversed: ${last} -> ${now}`);
      last = now;
    }
  }
});
