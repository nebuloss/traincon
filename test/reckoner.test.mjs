// Keeping the drawn train from jumping.
//
// The map recomputes position from the shared motion model many times a
// second, so it already agrees with the server between updates. What it cannot
// avoid is the model's input changing: a refresh that revises a leg's times
// moves the modelled position, and following that instantly makes the train
// teleport — backwards if the delay grew, which reads as the train physically
// reversing.
//
// These are the guarantees: never backwards under power, never a visible jump
// for an ordinary revision, and an immediate move for a change too large to be
// the same journey.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Reckoner } = await import(path.join(ROOT, 'src/client/core/Reckoner.ts'));

/** One frame at the animation's real rate. */
const FRAME = 80;

test('the first position is taken as-is', () => {
  const r = new Reckoner();
  assert.equal(r.follow(10, true, FRAME), 10);
  assert.equal(r.current, 10);
});

test('with the model steady, the drawn position follows it', () => {
  const r = new Reckoner();
  r.follow(10, true, FRAME);
  for (let i = 0; i < 100; i++) r.follow(10.5, true, FRAME);
  assert.ok(Math.abs(r.current - 10.5) < 0.01, `settled at ${r.current}`);
});

test('a revision is eased in, not jumped', () => {
  const r = new Reckoner();
  r.follow(12, true, FRAME);

  // A refresh moves the modelled position 600 m forward.
  const after = r.follow(12.6, true, FRAME);
  assert.ok(after - 12 < 0.05, `jumped ${((after - 12) * 1000).toFixed(0)} m in one frame`);
  assert.ok(after > 12, 'but it should be moving toward it');
});

test('it never runs backwards while going forwards', () => {
  const r = new Reckoner();
  let last = r.follow(20, true, FRAME);

  // The model repeatedly revises backwards, as a growing delay would.
  for (let round = 0; round < 20; round++) {
    const target = 20 - round * 0.1;
    for (let f = 0; f < 12; f++) {
      const now = r.follow(target, true, FRAME);
      assert.ok(now >= last - 1e-9, `reversed: ${last} -> ${now}`);
      last = now;
    }
  }
});

test('a position that ran ahead waits to be caught up', () => {
  const r = new Reckoner();
  r.follow(30, true, FRAME);

  // Model says 29.5: half a kilometre behind what is drawn.
  for (let f = 0; f < 40; f++) r.follow(29.5, true, FRAME);
  assert.ok(r.current >= 30 - 1e-9, 'must hold, not slide back');

  // Once the model passes it, motion resumes.
  for (let f = 0; f < 40; f++) r.follow(30.4, true, FRAME);
  assert.ok(r.current > 30, `resumed to ${r.current}`);
});

test('a stopped train may be corrected backwards', () => {
  // With no speed there is nothing to catch up, so holding would freeze a
  // genuine correction in place for ever.
  const r = new Reckoner();
  r.follow(30, false, FRAME);
  for (let f = 0; f < 80; f++) r.follow(29.5, false, FRAME);
  assert.ok(Math.abs(r.current - 29.5) < 0.05, `stuck at ${r.current}`);
});

test('a change too large for one journey is taken at once', () => {
  const r = new Reckoner();
  r.follow(10, true, FRAME);
  // Twenty kilometres: a re-identified train, not a revised delay.
  assert.equal(r.follow(30, true, FRAME), 30);
});

test('reset makes the next position a fresh start', () => {
  const r = new Reckoner();
  r.follow(120, true, FRAME);
  r.reset();
  assert.equal(r.current, null);
  assert.equal(r.follow(3, true, FRAME), 3, 'must not ease across from the old train');
});

test('a long frame gap closes more of the gap than a short one', () => {
  const short = new Reckoner();
  short.follow(10, true, FRAME);
  short.follow(11, true, 50);

  const long = new Reckoner();
  long.follow(10, true, FRAME);
  long.follow(11, true, 1000);

  assert.ok(long.current > short.current, 'convergence should track elapsed time');
  assert.ok(long.current <= 11 + 1e-9, 'and never overshoot the target');
});
