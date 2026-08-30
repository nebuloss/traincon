// Reconciling the animated train with the server's position.
//
// Animating between updates introduces a failure the stationary marker did not
// have: every thirty seconds a real position arrives that will not match the
// estimate. Snapping to it makes the train teleport — and a train that jumps
// backwards looks broken in a way that a train standing still does not.
//
// These are the guarantees: it never reverses while running forward, it never
// jumps for an ordinary correction, and it does snap when the correction is
// too large to be drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Reckoner } = await import(path.join(ROOT, 'src/client/core/Reckoner.ts'));

const SEC = 1000;

test('the first position is taken as-is', () => {
  const r = new Reckoner();
  assert.equal(r.update(10, 200, 0), 'snap');
  assert.equal(r.at(0), 10);
});

test('between updates it advances at the given speed', () => {
  const r = new Reckoner();
  r.update(10, 180, 0); // 180 km/h = 3 km per minute
  assert.ok(Math.abs(r.at(60 * SEC) - 13) < 0.01, `got ${r.at(60 * SEC)}`);
});

test('a correction is blended, not jumped', () => {
  const r = new Reckoner();
  r.update(10, 200, 0);

  // 30 s later the estimate is at 11.67 km; the server says 11.0 — the
  // estimate overran by 0.67 km.
  const before = r.at(30 * SEC);
  assert.equal(r.update(11.0, 200, 30 * SEC), 'blend');

  // The very next frame must not move the train appreciably.
  const after = r.at(30 * SEC + 16);
  assert.ok(Math.abs(after - before) < 0.01, `jumped ${(after - before).toFixed(3)} km`);
});

test('it never runs backwards while going forwards', () => {
  const r = new Reckoner();
  r.update(10, 250, 0);

  let last = r.at(0);
  let t = 0;
  // Six server updates, each one placing the train behind the estimate, which
  // is the case that produced a visible reversal.
  for (let u = 1; u <= 6; u++) {
    const serverT = u * 30 * SEC;
    // The server consistently reports less progress than dead reckoning made.
    r.update(10 + u * 1.8, 250, serverT);
    for (; t <= serverT + 30 * SEC; t += 250) {
      const now = r.at(t);
      assert.ok(now >= last - 1e-9, `reversed at ${t / 1000}s: ${last} -> ${now}`);
      last = now;
    }
  }
});

test('an estimate that overran waits rather than sliding back', () => {
  const r = new Reckoner();
  r.update(10, 300, 0);
  const overrun = r.at(30 * SEC); // 12.5 km

  // Server says it is only at 11.5 — a kilometre behind the estimate.
  r.update(11.5, 300, 30 * SEC);

  // It holds while the true position catches up, then resumes.
  const held = r.at(30 * SEC + 2 * SEC);
  assert.ok(held >= overrun - 1e-9, 'must not go backwards');
  const later = r.at(60 * SEC);
  assert.ok(later > held, 'and must start moving again once caught up');
});

test('a large correction snaps, because blending it would be a lie', () => {
  const r = new Reckoner();
  r.update(10, 200, 0);
  r.at(30 * SEC);

  // Twenty kilometres out: a re-identified train or a feed revision, not drift.
  assert.equal(r.update(30, 200, 30 * SEC), 'snap');
  assert.ok(Math.abs(r.at(30 * SEC) - 30) < 0.01, 'must show the true position');
});

test('a stopped train stays exactly where it was put', () => {
  const r = new Reckoner();
  r.update(10, 0, 0);
  assert.equal(r.at(0), 10);
  assert.equal(r.at(60 * SEC), 10, 'a stationary train must not creep');
});

test('a backward correction is honoured once the train has stopped', () => {
  // With no speed there is nothing to catch up, so the monotonic guard must
  // not freeze a genuine correction in place for ever.
  const r = new Reckoner();
  r.update(10, 200, 0);
  r.at(30 * SEC);
  r.update(11, 0, 30 * SEC);
  const settled = r.at(30 * SEC + 10 * SEC);
  assert.ok(Math.abs(settled - 11) < 0.05, `stuck at ${settled.toFixed(2)} instead of 11`);
});

test('reset clears the estimate so a different train starts clean', () => {
  const r = new Reckoner();
  r.update(120, 200, 0);
  r.reset();
  assert.equal(r.update(3, 200, 0), 'snap', 'a new train must not blend against the old one');
  assert.equal(r.at(0), 3);
});
