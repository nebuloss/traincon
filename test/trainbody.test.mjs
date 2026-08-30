// The train drawn on the ground, seen from above.
//
// The point of drawing it as geometry rather than as an icon is that a 200 m
// train on the approach to a station is on a curve, and a rigid box laid over
// a curve leaves the rails at both ends. These check the things that justify
// the complexity: that the cars follow the track, that each one still looks
// like a car, and that the plan view has the parts a plan view should have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Track } = await import(path.join(ROOT, 'src/client/core/Track.ts'));
const { carCount, trainBody } = await import(path.join(ROOT, 'src/client/core/TrainBody.ts'));

const LAT0 = 44.826; // Bordeaux, near enough for the scale factors.
const LON0 = -0.556;
const KM_PER_DEG = 111.32;
const COS = Math.cos((LAT0 * Math.PI) / 180);

/** A dead straight track running north, `km` long. */
function straight(km) {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([LON0, LAT0 + (km * (i / 40)) / KM_PER_DEG]);
  return new Track(pts);
}

/** A quarter circle of the given radius, the sort of curve a station throat has. */
function curve(radiusKm) {
  const pts = [];
  for (let i = 0; i <= 90; i++) {
    const th = (i * Math.PI) / 180;
    pts.push([
      LON0 + (radiusKm * Math.sin(th)) / (KM_PER_DEG * COS),
      LAT0 + (radiusKm * (1 - Math.cos(th))) / KM_PER_DEG,
    ]);
  }
  return new Track(pts);
}

/** Local metres, east/north of the reference point — the shapes are small. */
const xy = ([lon, lat]) => [(lon - LON0) * KM_PER_DEG * 1000 * COS, (lat - LAT0) * KM_PER_DEG * 1000];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const parts = (geo, part) => geo.features.filter((f) => f.properties.part === part);
const bodies = (geo) => parts(geo, 'body');

/** The corners of a feature, in metres, without the repeated closing point. */
const corners = (f) => f.geometry.coordinates[0].slice(0, -1).map(xy);

/**
 * The long axis of a shape, by principal component — robust whatever the ends
 * look like, which matters now the nose is a curve and the tail is rounded.
 */
function axis(pts) {
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  let xx = 0, yy = 0, xyv = 0;
  for (const p of pts) {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    xx += dx * dx; yy += dy * dy; xyv += dx * dy;
  }
  // Direction of maximum variance.
  const theta = 0.5 * Math.atan2(2 * xyv, xx - yy);
  return { centre: c, dir: [Math.cos(theta), Math.sin(theta)] };
}

/**
 * Bearing of a body in degrees, and the midpoints of its two ends.
 *
 * The principal axis has no direction of its own — it comes out pointing
 * either way — so it is turned to agree with the track, or "front" and "back"
 * swap from one car to the next.
 */
function frame(f, track) {
  const pts = corners(f);
  const { centre } = axis(pts);
  let { dir } = axis(pts);
  if (track) {
    const lon = LON0 + centre[0] / (KM_PER_DEG * 1000 * COS);
    const lat = LAT0 + centre[1] / (KM_PER_DEG * 1000);
    const on = track.at(track.distanceAt(lat, lon));
    const b = ((on?.bearing ?? 0) * Math.PI) / 180;
    const along = [Math.sin(b), Math.cos(b)];
    if (dir[0] * along[0] + dir[1] * along[1] < 0) dir = [-dir[0], -dir[1]];
  }
  const proj = pts.map((p) => (p[0] - centre[0]) * dir[0] + (p[1] - centre[1]) * dir[1]);
  const lo = Math.min(...proj), hi = Math.max(...proj);
  const near = (t) => pts.filter((_, i) => Math.abs(proj[i] - t) < 0.6);
  const end = (t) => {
    const g = near(t);
    return g.length > 1 ? mid(g[0], g[g.length - 1]) : g[0] ?? centre;
  };
  return { back: end(lo), front: end(hi), length: hi - lo, deg: (Math.atan2(dir[0], dir[1]) * 180) / Math.PI };
}

/** Area by the shoelace formula, in square metres. */
const area = (f) => {
  const p = corners(f);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return Math.abs(a) / 2;
};

test('a train is divided into something like real cars', () => {
  assert.equal(carCount(200), 8); // a TGV rake, near enough
  assert.equal(carCount(80), 3); // a regional unit
  assert.ok(carCount(10) >= 2, 'never a single undivided blob');
  assert.ok(carCount(5000) <= 24, 'and never hatching');
});

test('the body is laid along the track, not across it', () => {
  const track = straight(10);
  const body = trainBody(track, 5, 200, 2.9, 'ter');
  const cars = bodies(body);
  assert.ok(cars.length >= 2);
  // Due north, and every car agrees. The axis is undirected, so ±180 is fine.
  for (const f of cars) {
    const d = Math.abs(frame(f, track).deg) % 180;
    assert.ok(d < 1 || d > 179, `car points ${d.toFixed(1)}° off north`);
  }
});

test('the whole train is as long as it should be', () => {
  const track = straight(10);
  const cars = bodies(trainBody(track, 5, 200, 2.9, 'ter'));
  const tail = frame(cars[0], track).back;
  const nose = frame(cars[cars.length - 1], track).front;
  assert.ok(Math.abs(dist(tail, nose) - 200) < 15, `${dist(tail, nose).toFixed(0)} m`);
});

test('the body is as wide as a rail vehicle', () => {
  // Measured on a middle car: the first is rounded off at the back and the
  // last tapers to a nose, so neither is full width at its end.
  const track = straight(10);
  const cars = bodies(trainBody(track, 5, 200, 2.9, 'ter'));
  const f = frame(cars[2], track);
  const across = area(cars[2]) / f.length;
  assert.ok(Math.abs(across - 2.9) < 0.3, `${across.toFixed(2)} m across`);
});

test('on a curve the cars turn with the track', () => {
  // This is the whole reason the train is geometry and not an icon.
  const track = curve(0.6);
  const cars = bodies(trainBody(track, Math.min(track.length, 1.0), 200, 2.9, 'ter'));
  const swept = Math.abs(frame(cars[0], track).deg - frame(cars[cars.length - 1], track).deg);
  // 200 m of train on a 600 m radius sweeps about 19°.
  assert.ok(swept > 10 && swept < 30, `swept ${swept.toFixed(1)}°`);
});

test('no car strays from the rails on a curve', () => {
  // A single rigid rectangle over this arc would stand about 8 m off the
  // centreline at its ends — more than a track's width from where it belongs.
  const track = curve(0.6);
  let worst = 0;
  for (const f of bodies(trainBody(track, 1.0, 200, 2.9, 'ter'))) {
    for (const [lon, lat] of f.geometry.coordinates[0].slice(0, -1)) {
      const on = track.at(track.distanceAt(lat, lon));
      worst = Math.max(worst, dist(xy([lon, lat]), xy([on.lon, on.lat])));
    }
  }
  assert.ok(worst < 3, `worst corner ${worst.toFixed(2)} m off the line`);
});

test('a high-speed set gets a longer nose than a regional one', () => {
  // Compared as area against a plain car of the same train: a longer taper
  // takes away more of the rectangle.
  const kept = (family) => {
    const cars = bodies(trainBody(straight(10), 5, 200, 2.9, family));
    return area(cars[cars.length - 1]) / area(cars[2]);
  };
  assert.ok(kept('tgv') < kept('ter'), `tgv ${kept('tgv').toFixed(2)} vs ter ${kept('ter').toFixed(2)}`);
  // At the width it is actually drawn — inflated for legibility — the nose
  // runs to the cap of half a car and takes a real bite out of it.
  const drawn = bodies(trainBody(straight(10), 5, 200, 26, 'tgv'));
  assert.ok(
    area(drawn[drawn.length - 1]) / area(drawn[2]) < 0.92,
    'the nose should be visibly tapered at the drawn width',
  );
});

test('the nose comes to a point and the tail does not', () => {
  // A train has one sharp end. Two would look like a mistake.
  const track = straight(10);
  const cars = bodies(trainBody(track, 5, 200, 2.9, 'tgv'));
  // Width at the very end, from how many corners sit there.
  const endWidth = (f, t) => {
    const pts = corners(f);
    const { centre, dir } = axis(pts);
    const proj = pts.map((p) => (p[0] - centre[0]) * dir[0] + (p[1] - centre[1]) * dir[1]);
    const g = pts.filter((_, i) => Math.abs(proj[i] - t) < 0.6);
    return g.length > 1 ? dist(g[0], g[g.length - 1]) : 0;
  };
  const p = axis(corners(cars[cars.length - 1]));
  const projN = corners(cars[cars.length - 1]).map(
    (q) => (q[0] - p.centre[0]) * p.dir[0] + (q[1] - p.centre[1]) * p.dir[1],
  );
  assert.ok(endWidth(cars[cars.length - 1], Math.max(...projN)) < 0.6, 'the nose is a point');
  const q = axis(corners(cars[0]));
  const projT = corners(cars[0]).map(
    (r) => (r[0] - q.centre[0]) * q.dir[0] + (r[1] - q.centre[1]) * q.dir[1],
  );
  assert.ok(endWidth(cars[0], Math.min(...projT)) > 1.2, 'the tail is rounded, not pointed');
});

test('only the leading car is flagged as such', () => {
  const cars = bodies(trainBody(straight(10), 5, 200, 2.9, 'tgv'));
  assert.equal(cars.filter((f) => f.properties.lead === 1).length, 1);
  assert.equal(cars[cars.length - 1].properties.lead, 1);
});

test('a train just starting out is not drawn off the end of its route', () => {
  // 50 m into the journey, a 200 m train has no route behind it to lie on.
  for (const f of trainBody(straight(10), 0.05, 200, 2.9, 'ter').features) {
    for (const [, lat] of f.geometry.coordinates[0]) {
      assert.ok(lat >= LAT0 - 1e-6, 'nothing behind the start of the line');
    }
  }
});

test('a train at the very start of the route draws nothing rather than nonsense', () => {
  assert.equal(trainBody(straight(10), 0, 200, 2.9, 'ter').features.length, 0);
});

test('the polygons are closed rings', () => {
  for (const f of trainBody(straight(10), 5, 200, 2.9, 'tgv').features) {
    const ring = f.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  }
});

test('a coupled 400 m set is drawn twice as long as one unit', () => {
  const track = straight(10);
  assert.ok(bodies(trainBody(track, 5, 400, 2.9, 'tgv')).length > bodies(trainBody(track, 5, 200, 2.9, 'tgv')).length);
});

test('the cars touch, so the train is not a dashed line', () => {
  // They used to be separated by a fraction of a car length. At the width the
  // body is actually drawn that gap was wider than the body, and the train
  // read as a row of dashes.
  const track = straight(10);
  const cars = bodies(trainBody(track, 5, 200, 2.9, 'ter'));
  for (let i = 0; i < cars.length - 1; i++) {
    const gap = dist(frame(cars[i], track).front, frame(cars[i + 1], track).back);
    assert.ok(gap < 0.5, `gap of ${gap.toFixed(2)} m at coupling ${i}`);
  }
});

test('the divisions can be capped when there are few pixels to draw them in', () => {
  // Far out a 400 m train would be chopped into 17 cars across 60 pixels,
  // which is hatching, not a train.
  assert.equal(carCount(400, 3), 3);
  assert.equal(carCount(400, 99), 17);
  assert.ok(carCount(400, 0) >= 2, 'never fewer than two');
  assert.equal(bodies(trainBody(straight(10), 5, 400, 2.9, 'tgv', 4)).length, 4);
});

test('a wider body is still centred on the track', () => {
  // The width is inflated for legibility at low zoom; that must widen the
  // train about the centreline, not push it to one side of the rails.
  const track = straight(10);
  for (const f of bodies(trainBody(track, 5, 200, 26, 'ter'))) {
    const back = frame(f, track).back;
    // Back to lon/lat to ask the track where that is.
    const lon = LON0 + back[0] / (KM_PER_DEG * 1000 * COS);
    const lat = LAT0 + back[1] / (KM_PER_DEG * 1000);
    const on = track.at(track.distanceAt(lat, lon));
    assert.ok(dist(back, xy([on.lon, on.lat])) < 0.6, 'back edge centred on the line');
  }
});

// ---------------------------------------------------------- the plan view ---

test('it is drawn as a plan view, not as a silhouette', () => {
  // From above a train is mostly roof, with things standing on it. A body
  // with nothing on it is the row-of-boxes drawing this replaced.
  const geo = trainBody(straight(10), 5, 200, 2.9, 'tgv');
  assert.ok(parts(geo, 'roof').length >= 4, 'a roof panel per car');
  assert.ok(parts(geo, 'panto').length >= 1, 'a pantograph');
  assert.equal(parts(geo, 'glass').length, 1, 'one windscreen, at the front');
  assert.ok(parts(geo, 'gangway').length >= 1, 'gangways between the cars');
});

test('the roof sits inside the body, so the livery shows around it', () => {
  const geo = trainBody(straight(10), 5, 200, 2.9, 'ter');
  const car = bodies(geo)[2];
  const roof = parts(geo, 'roof')[2];
  assert.ok(area(roof) < area(car) * 0.7, 'the roof is inset');
  assert.ok(area(roof) > area(car) * 0.2, 'but it is the dominant surface');
});

test('a high-speed set is powered at both ends, a regional unit once', () => {
  // Two power cars is what a TGV is.
  assert.equal(parts(trainBody(straight(10), 5, 200, 2.9, 'tgv'), 'panto').length, 2);
  assert.equal(parts(trainBody(straight(10), 5, 200, 2.9, 'ter'), 'panto').length, 1);
});

test('the windscreen is at the sharp end', () => {
  const geo = trainBody(straight(10), 5, 200, 2.9, 'tgv');
  const cars = bodies(geo);
  const glass = parts(geo, 'glass')[0];
  assert.equal(glass.properties.lead, 1, 'on the leading car');
  const track = straight(10);
  const nose = frame(cars[cars.length - 1], track).front;
  const tail = frame(cars[0], track).back;
  const g = frame(glass, track).front;
  assert.ok(dist(g, nose) < dist(g, tail), 'nearer the nose than the tail');
});

test('every piece is tagged, so the map can style it', () => {
  const known = new Set(['body', 'roof', 'glass', 'panto', 'kit', 'gangway']);
  for (const f of trainBody(straight(10), 5, 200, 2.9, 'tgv').features) {
    assert.ok(known.has(f.properties.part), `unknown part ${f.properties.part}`);
    assert.ok(f.properties.family, 'and knows what kind of train it belongs to');
  }
});

test('a car is never drawn as a square', () => {
  // The width is inflated at low zoom, and a 200 m train cut into eight cars
  // is 25 m each — against a body drawn 30 m wide. That is a row of squares,
  // which is the one thing a plan view must not look like, so the train is
  // divided into fewer and longer cars instead.
  const track = straight(10);
  for (const width of [3, 12, 26, 40]) {
    for (const f of bodies(trainBody(track, 5, 200, width, 'ter'))) {
      const long = frame(f, track).length;
      assert.ok(long > width * 1.2, `car ${long.toFixed(0)} m long by ${width} m wide`);
    }
  }
});
