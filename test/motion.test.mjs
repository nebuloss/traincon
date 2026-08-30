// The motion model both sides run.
//
// The server evaluates it once a minute when the feed refreshes; the map
// evaluates it many times a second so the train moves. The point of sharing it
// is that the two cannot disagree — if they did, every server update would
// yank the train to a different place, which is exactly what animating it was
// supposed to stop.
//
// So these check the model's own shape, and that the sampled form the client
// receives matches the exact curve the server holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { sampleProfile, distanceFraction, PROFILE_SAMPLES } = await import(
  path.join(ROOT, 'src/shared/motion.ts')
);
const { speedAndTime } = await import(path.join(ROOT, 'dist-server/server/RailGraph.js'));

/** A leg of `km` split into `n` even vertices, at the given line speeds. */
function leg(km, n, speedAt = () => 300) {
  const cum = Array.from({ length: n + 1 }, (_, i) => (i * km) / n);
  const segV = Array.from({ length: n }, (_, i) => speedAt(i, n));
  return { cum, ...speedAndTime(cum, segV) };
}

/** The exact answer, straight off the full curve the server holds. */
function exact(cum, cumT, f) {
  const n = cum.length;
  const t = f * cumT[n - 1];
  let j = 1;
  while (j < n - 1 && cumT[j] < t) j++;
  const dt = cumT[j] - cumT[j - 1];
  const within = dt > 0 ? (t - cumT[j - 1]) / dt : 0;
  return (cum[j - 1] + (cum[j] - cum[j - 1]) * within) / cum[n - 1];
}

test('the profile runs from one end of the leg to the other', () => {
  const { cum, cumT } = leg(60, 300);
  const p = sampleProfile(cum, cumT);
  assert.equal(p.length, PROFILE_SAMPLES + 1);
  assert.equal(p[0], 0);
  assert.equal(p[p.length - 1], 1, 'a train must reach its own terminus');
});

test('progress only ever increases', () => {
  const { cum, cumT } = leg(120, 500, (i, n) => (i % 60 < 10 ? 90 : 300));
  const p = sampleProfile(cum, cumT);
  for (let i = 1; i < p.length; i++) {
    assert.ok(p[i] >= p[i - 1] - 1e-12, `went backwards at sample ${i}`);
  }
});

test('a train covers less ground at the ends than in the middle', () => {
  // The signature of acceleration and braking, and the reason a straight line
  // put the train too far along early in a leg.
  const { cum, cumT } = leg(60, 400);
  const p = sampleProfile(cum, cumT);
  const firstTenth = distanceFraction(p, 0.1);
  const middleTenth = distanceFraction(p, 0.55) - distanceFraction(p, 0.45);
  assert.ok(firstTenth < 0.1, `covered ${(firstTenth * 100).toFixed(1)}% in the first tenth`);
  assert.ok(middleTenth > 0.1, 'and more than a tenth across the middle');
});

test('the sampled profile matches the exact curve the server holds', () => {
  // If these drift apart, every refresh moves the train.
  const shapes = [
    ['uniform 300', leg(200, 600)],
    ['short leg', leg(8, 120, () => 90)],
    ['mid-leg restriction', leg(60, 400, (i, n) => (i > n * 0.5 && i < n * 0.6 ? 80 : 300))],
    ['repeated limits', leg(120, 500, (i) => (i % 50 < 8 ? 120 : 300))],
    ['very long run', leg(500, 1400, () => 320)],
  ];

  for (const [label, { cum, cumT }] of shapes) {
    const p = sampleProfile(cum, cumT);
    const lengthKm = cum[cum.length - 1];
    let worstM = 0;
    for (let k = 0; k <= 500; k++) {
      const f = k / 500;
      worstM = Math.max(worstM, Math.abs(distanceFraction(p, f) - exact(cum, cumT, f)) * lengthKm * 1000);
    }
    // Comfortably inside the accuracy of the position itself, which comes from
    // a feed that only observes trains where they stop.
    assert.ok(worstM < 200, `${label}: ${worstM.toFixed(0)} m from the exact curve`);
  }
});

test('the ends are exact, whatever the sampling does in between', () => {
  const { cum, cumT } = leg(500, 1400);
  const p = sampleProfile(cum, cumT);
  assert.equal(distanceFraction(p, 0), 0);
  assert.equal(distanceFraction(p, 1), 1);
});

test('time outside the leg is clamped, not extrapolated', () => {
  const { cum, cumT } = leg(60, 300);
  const p = sampleProfile(cum, cumT);
  assert.equal(distanceFraction(p, -3), 0);
  assert.equal(distanceFraction(p, 4), 1);
});

test('a leg with no profile falls back to a straight line', () => {
  // Legs with no routed geometry get none, and the rest of the code assumes a
  // straight line for those too.
  for (const empty of [undefined, [], [0.4]]) {
    assert.equal(distanceFraction(empty, 0.25), 0.25);
    assert.equal(distanceFraction(empty, 0.8), 0.8);
  }
});

test('degenerate curves produce no profile rather than nonsense', () => {
  assert.deepEqual(sampleProfile([], []), []);
  assert.deepEqual(sampleProfile([0], [0]), []);
  assert.deepEqual(sampleProfile([0, 0], [0, 0]), [], 'a zero-length leg has no shape');
  assert.deepEqual(sampleProfile([0, 5], [0, 0]), [], 'nor one taking no time');
});
