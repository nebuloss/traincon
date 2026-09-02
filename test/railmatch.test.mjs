// Laying a train's route onto the rails it actually runs on.
//
// The route the server draws is the national network graph's centreline: one
// stroke per railway, up the middle of however many tracks are on the ground.
// The tiles carry OpenStreetMap's surveyed track, which is what the map draws.
// Zoomed in the two visibly disagree, and the survey is the one to believe.
//
// The catch that shapes the whole design: the route is coarse. Its vertices
// are 195 m apart on median and 77% of its gaps exceed 100 m, so at the zooms
// where the offset shows there may be a single vertex on screen. Snapping
// vertices would snap almost nothing — the route has to be resampled first.
//
// This module is pure geometry, so unlike the map tests it can be run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SAMPLE_M, matchToRails } = await import(path.join(ROOT, 'src/core/RailMatch.ts'));

const LAT = 47.28;
const LON = 1.38;
const M = 111320;
const KX = M * Math.cos((LAT * Math.PI) / 180);

/** A point `east`/`north` metres from the reference. */
const at = (east, north) => [LON + east / KX, LAT + north / M];
const apart = (p, q) => Math.hypot((q[0] - p[0]) * KX, (q[1] - p[1]) * M);
/** How far east of the reference meridian a result point sits. */
const east = (p) => (p[0] - LON) * KX;
const line = (key, ...pts) => ({ key, points: pts });

/** Samples every `step` metres along a polyline, with the bearing it runs at. */
function walk(pts, step = SAMPLE_M) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = apart(a, b);
    const brg = (Math.atan2((b[0] - a[0]) * KX, (b[1] - a[1]) * M) * 180) / Math.PI;
    for (let d = 0; d < len; d += step) {
      const f = d / len;
      out.push({
        lon: a[0] + (b[0] - a[0]) * f,
        lat: a[1] + (b[1] - a[1]) * f,
        bearing: ((brg % 360) + 360) % 360,
      });
    }
  }
  return out;
}

test('a route offset from the track is laid onto it', () => {
  // The everyday case: the centreline runs parallel to the rails, a few metres
  // to one side, and the drawn route sits visibly beside the track.
  const rails = [line('main', at(0, -600), at(0, 600))];
  const runs = matchToRails(walk([at(8, -400), at(8, 400)]), rails);

  assert.equal(runs.length, 1, 'one unbroken run');
  assert.ok(runs[0].length > 30, 'and it is drawn, not a stub');
  for (const p of runs[0]) {
    assert.ok(Math.abs(east(p)) < 0.05, `on the rails, not ${east(p).toFixed(2)} m off them`);
  }
});

test('a curve comes out curved, not chorded', () => {
  // This is what resampling buys. The route crosses an 800 m radius curve in
  // 200 m steps; each of those chords sits about 6 m inside the arc, and at
  // the zoom this is drawn at that is a line clearly off the track.
  const R = 800;
  const arc = (deg) => at(R * Math.sin((deg * Math.PI) / 180), R * (1 - Math.cos((deg * Math.PI) / 180)));
  const rails = [line('curve', ...Array.from({ length: 121 }, (_, i) => arc(i * 0.5)))];

  // The route as the server gives it: vertices every ~200 m, i.e. every 14°.
  const coarse = Array.from({ length: 5 }, (_, i) => arc(i * 14));
  const sagM = (() => {
    // How far the raw chord departs from the arc at its midpoint.
    const mid = arc(7);
    const a = coarse[0];
    const b = coarse[1];
    const t =
      (((mid[0] - a[0]) * (b[0] - a[0]) * KX * KX + (mid[1] - a[1]) * (b[1] - a[1]) * M * M) /
        (apart(a, b) ** 2));
    return apart(mid, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  })();
  assert.ok(sagM > 4, `the chord really does cut the corner (${sagM.toFixed(1)} m)`);

  const runs = matchToRails(walk(coarse), rails);
  assert.equal(runs.length, 1);
  // Every matched point is on the arc, to well under the width of a rail.
  for (const p of runs[0]) {
    const r = Math.hypot(east(p), R - (p[1] - LAT) * M);
    assert.ok(Math.abs(r - R) < 0.6, `${Math.abs(r - R).toFixed(2)} m off the arc`);
  }
});

test('on a double track it picks one running line and stays on it', () => {
  // Nearest-track alone flickers between the two: they are 4.5 m apart and
  // both point the same way, so a wandering centreline crosses between them.
  // France runs on the left, and having chosen, the line has to stay chosen.
  const rails = [
    line('west', at(-2.25, -600), at(-2.25, 600)),
    line('east', at(2.25, -600), at(2.25, 600)),
  ];
  // A centreline that wanders either side of the middle, as a real one does.
  const wobbly = [at(-1, -400), at(1.5, -100), at(-1.5, 150), at(1, 400)];
  const runs = matchToRails(walk(wobbly), rails, { keepLeft: () => true });

  assert.equal(runs.length, 1, 'no break');
  for (const p of runs[0]) {
    assert.ok(east(p) < 0, `left-hand running: ${east(p).toFixed(2)} m`);
    assert.ok(Math.abs(east(p) + 2.25) < 0.05, 'and on that rail, not between the two');
  }
});

test('where nothing is surveyed, nothing is drawn', () => {
  // The schematic line is still there underneath. Reaching for it here would
  // put a kink of several metres in an otherwise correct line, and inventing
  // track is worse than admitting the survey stops.
  assert.deepEqual(matchToRails(walk([at(0, -300), at(0, 300)]), []), []);

  const faraway = [line('elsewhere', at(400, -600), at(400, 600))];
  assert.deepEqual(matchToRails(walk([at(0, -300), at(0, 300)]), faraway), []);
});

test('a gap in the survey breaks the line rather than bridging it', () => {
  const rails = [
    line('a', at(0, -400), at(0, -100)),
    line('a', at(0, 100), at(0, 400)),
  ];
  const runs = matchToRails(walk([at(0, -350), at(0, 350)]), rails);

  assert.equal(runs.length, 2, 'two runs, not one straight line through the gap');
  const [first, second] = runs;
  assert.ok(first.at(-1)[1] < LAT - 90 / M, 'the first stops where the track does');
  assert.ok(second[0][1] > LAT + 90 / M, 'the second starts where it resumes');
});

test('a jump along the track is a break, and the line recovers after it', () => {
  // The guard against a sample thrown somewhere else entirely. Were the point
  // simply dropped, every later sample would be measured against a position
  // the route had long since left and the rest of the line would go with it.
  const rails = [line('main', at(0, -600), at(0, 600))];
  const samples = [...walk([at(0, -500), at(0, -300)]), ...walk([at(0, 300), at(0, 500)])];
  const runs = matchToRails(samples, rails);

  assert.equal(runs.length, 2, 'the 600 m step is not drawn as track');
  assert.ok(runs[1].length > 5, 'and the far side is still matched');
});

test('the route stays on the track it started on', () => {
  // The bug this exists to stop, and the measurement behind it: the schematic
  // route's own offset from the survey is about three metres on median and
  // more in places, while the running lines of a double track are four and a
  // half metres apart. The offset is the larger of the two, so as it drifts
  // along the route the nearest track changes from one running line to the
  // other, and a line drawn by choosing the nearest for each sample steps
  // sideways between them. Reported as the blue line switching track.
  const rails = [
    line('west', at(-2.25, -900), at(-2.25, 900)),
    line('east', at(2.25, -900), at(2.25, 900)),
  ];
  // A centreline that wanders from five metres one side to five metres the
  // other over the run — well inside what the two surveys really disagree by,
  // and more than enough to put the far track nearer than the near one.
  const drifting = [at(-5, -800), at(-5, -400), at(5, 400), at(5, 800)];
  const runs = matchToRails(walk(drifting), rails);

  assert.equal(runs.length, 1, 'no break');
  const first = east(runs[0][0]);
  for (const p of runs[0]) {
    assert.ok(
      Math.abs(east(p) - first) < 0.05,
      `changed track: ${first.toFixed(2)} m to ${east(p).toFixed(2)} m`,
    );
  }
});

test('a seed is the track the train is on, and it is obeyed', () => {
  // The seed is whichever track the train itself was snapped to, so the route
  // through a station comes out on the same platform road the train is drawn
  // on. It settles the matter rather than nudging it: the running side already
  // governed that choice when the train was placed, and a train genuinely on
  // the other line — single track, works, Alsace-Moselle — is still where its
  // route should be drawn.
  const rails = [
    line('near', at(-2.25, -300), at(-2.25, 300)),
    line('far', at(-4.5, -300), at(-4.5, 300)),
    line('other-side', at(2.25, -300), at(2.25, 300)),
  ];
  const route = walk([at(0, -250), at(0, 250)]);

  for (const [seed, want] of [
    ['far', -4.5],
    ['other-side', 2.25],
  ]) {
    const runs = matchToRails(route, rails, { seed, keepLeft: () => true });
    assert.equal(runs.length, 1, `${seed}: one run`);
    assert.ok(
      runs[0].every((p) => Math.abs(east(p) - want) < 0.05),
      `seeded ${seed}: expected ${want} m, got ${east(runs[0][0]).toFixed(2)}`,
    );
  }
});

test('with no seed, the side the railway runs on decides', () => {
  // Nothing has been chosen yet, so the rule that picks is which side French
  // trains keep to — being deterministic, it cannot flicker.
  const rails = [
    line('left', at(-2.25, -300), at(-2.25, 300)),
    line('right', at(2.25, -300), at(2.25, 300)),
  ];
  const runs = matchToRails(walk([at(0, -250), at(0, 250)]), rails, { keepLeft: () => true });
  assert.equal(runs.length, 1);
  assert.ok(runs[0].every((p) => east(p) < 0), 'left-hand running');
});
