// The speed profile behind position interpolation.
//
// A train's position between two stops is found by scaling a modelled speed
// profile onto the timetable's actual leg duration, so the shape of that
// profile is what decides where the train is drawn. It used to time each
// segment at its own line speed, which meant instantaneously dropping from 300
// to 160 km/h at a restriction — and placing the train too far along as a
// result. These pin the physics down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { speedAndTime } = await import(path.join(ROOT, 'dist-server/server/RailGraph.js'));

/** Cumulative distance for `n` segments of `stepKm` each. */
const evenly = (n, stepKm) => Array.from({ length: n + 1 }, (_, i) => i * stepKm);

test('a train starts and finishes at rest', () => {
  const cum = evenly(200, 0.1); // 20 km in 100 m steps
  const { v } = speedAndTime(cum, new Array(200).fill(300));
  assert.equal(v[0], 0);
  assert.equal(v[v.length - 1], 0);
  assert.ok(Math.max(...v) > 100, 'and gets up to speed in between');
});

test('speed never exceeds the line limit', () => {
  const cum = evenly(200, 0.1);
  const segV = new Array(200).fill(160);
  const { v } = speedAndTime(cum, segV);
  for (const s of v) assert.ok(s <= 160 + 1e-6, `${s} km/h over a 160 limit`);
});

test('acceleration is bounded, not instant', () => {
  const cum = evenly(200, 0.1);
  const { v } = speedAndTime(cum, new Array(200).fill(300));

  // 0.4 m/s² over 100 m can add at most sqrt(2*0.4*100) = 8.9 m/s from rest,
  // and less once already moving. Check the kinematics hold everywhere.
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1] / 3.6;
    const b = v[i] / 3.6;
    if (b <= a) continue;
    const implied = (b * b - a * a) / (2 * 100);
    assert.ok(implied <= 0.4 + 1e-6, `accelerated at ${implied.toFixed(2)} m/s²`);
  }
});

test('braking starts before a speed restriction, not at it', () => {
  // The whole point of the backward pass. 300 km/h down to 80 km/h is 61 m/s,
  // which at 0.5 m/s² needs roughly 1.5 km of braking.
  const cum = evenly(400, 0.05); // 20 km in 50 m steps
  const segV = new Array(400).fill(300);
  for (let i = 300; i < 400; i++) segV[i] = 80; // restriction from km 15
  const { v } = speedAndTime(cum, segV);

  // At the restriction itself the train must already be down to it.
  assert.ok(v[300] <= 81, `arrived at the limit doing ${v[300].toFixed(0)} km/h`);

  // And it must have been slowing well before — a kilometre earlier it should
  // already be off full line speed.
  assert.ok(v[280] < 295, `still at ${v[280].toFixed(0)} km/h 1 km before`);

  // But not braking absurdly early: 5 km out it is still running fast.
  assert.ok(v[200] > 200, `over-braked, only ${v[200].toFixed(0)} km/h 5 km out`);
});

test('cumulative time only ever increases, and stays finite', () => {
  const cum = evenly(200, 0.1);
  const segV = new Array(200).fill(0).map((_, i) => (i % 20 === 0 ? 40 : 220));
  const { cumT } = speedAndTime(cum, segV);

  assert.equal(cumT[0], 0);
  for (let i = 1; i < cumT.length; i++) {
    assert.ok(Number.isFinite(cumT[i]), `non-finite time at ${i}`);
    assert.ok(cumT[i] >= cumT[i - 1], `time went backwards at ${i}`);
  }
  // 20 km with restrictions should take a plausible while, not seconds or days.
  const minutes = cumT[cumT.length - 1] * 60;
  assert.ok(minutes > 4 && minutes < 60, `20 km modelled at ${minutes.toFixed(1)} min`);
});

test('a slow stretch takes longer to cross than a fast one', () => {
  const cum = evenly(100, 0.2);
  const fast = speedAndTime(cum, new Array(100).fill(300)).cumT;
  const slow = speedAndTime(cum, new Array(100).fill(90)).cumT;
  assert.ok(
    slow[slow.length - 1] > fast[fast.length - 1] * 1.5,
    'a 90 km/h line must be markedly slower than a 300 km/h one',
  );
});

test('degenerate paths do not produce infinities', () => {
  assert.deepEqual(speedAndTime([], []), { v: [], cumT: [] });
  assert.deepEqual(speedAndTime([0], []), { v: [0], cumT: [0] });

  // A single segment: both ends at rest, so the floor is what saves it.
  const one = speedAndTime([0, 1], [200]);
  assert.ok(Number.isFinite(one.cumT[1]) && one.cumT[1] > 0);

  // Zero-length segments, which a stitched graph can produce.
  const dup = speedAndTime([0, 0, 0.5, 0.5, 1], [100, 100, 100, 100]);
  for (const t of dup.cumT) assert.ok(Number.isFinite(t), 'zero-length segment broke the timing');
});
