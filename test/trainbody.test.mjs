// Where each vehicle of a train is put on the track.
//
// The train is drawn from artwork — one SVG per kind of vehicle — and this is
// the part that decides which vehicles it is made of and where each one goes.
// The reason it is per vehicle rather than one image for the whole train is a
// curve: a 200 m set on the approach to a station spans an arc, and a single
// rigid image laid over it stands about 8 m off the rails at each end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Track } = await import(path.join(ROOT, 'src/core/Track.ts'));
const { VEHICLE_M, consist, consistLength, trainCars } = await import(
  path.join(ROOT, 'src/core/TrainBody.ts')
);

const ART_DIR = path.join(ROOT, 'src/assets/train');
const ART_FILE = {
  power: 'power-car',
  artic: 'coach-artic',
  loco: 'loco',
  coach: 'coach',
  'emu-cab': 'emu-cab',
  'emu-mid': 'emu-mid',
};

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

const xy = ([lon, lat]) => [(lon - LON0) * KM_PER_DEG * 1000 * COS, (lat - LAT0) * KM_PER_DEG * 1000];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const at = (f) => xy(f.geometry.coordinates);
/** Which way the vehicle is going, with the rear cab's half-turn taken back out. */
const heading = (f) => f.properties.bearing - (f.properties.reversed ? 180 : 0);

// ------------------------------------------------------------- the consist ---

test('a TGV has a power car at each end', () => {
  // Both ends are noses, which is why a TGV looks the same coming or going.
  const r = consist('tgv', 200);
  assert.equal(r[0], 'power');
  assert.equal(r[r.length - 1], 'power');
  assert.ok(r.slice(1, -1).every((v) => v === 'artic'), 'articulated between them');
});

test('an Intercités is a locomotive and a rake of coaches', () => {
  // Hauled, not a multiple unit — and the loco leads.
  const r = consist('ic', 190);
  assert.equal(r[r.length - 1], 'loco', 'the loco is at the front');
  assert.ok(r.slice(0, -1).every((v) => v === 'coach'), 'Corail behind it');
  assert.equal(r.filter((v) => v === 'loco').length, 1, 'only the one');
});

test('a TER is a multiple unit with a cab at each end', () => {
  const r = consist('ter', 80);
  assert.equal(r[0], 'emu-cab');
  assert.equal(r[r.length - 1], 'emu-cab');
  assert.ok(!r.includes('loco'), 'no separate locomotive');
});

test('the three families are put together differently', () => {
  // The whole point of the artwork: you can tell them apart from above.
  const shapes = ['tgv', 'ic', 'ter'].map((f) => consist(f, 190).join(','));
  assert.equal(new Set(shapes).size, 3);
});

test('a longer train gets more vehicles, not longer ones', () => {
  // Length alone, with no word about coupling — see below for what a real
  // 400 m TGV is made of.
  const one = consist('tgv', 200);
  const two = consist('tgv', 400);
  assert.ok(two.length > one.length);
  assert.ok(consistLength(two) > consistLength(one) * 1.7);
});

test('the consist comes out about the length it was asked for', () => {
  for (const [family, want] of [
    ['tgv', 200],
    ['ic', 190],
    ['ter', 80],
    ['other', 120],
  ]) {
    const got = consistLength(consist(family, want));
    assert.ok(Math.abs(got - want) < 30, `${family}: ${got.toFixed(0)} m against ${want}`);
  }
});

test('a very long train is still capped, so it does not become hatching', () => {
  assert.ok(consist('tgv', 5000, 12).length <= 12);
});

// ----------------------------------------------------------- the placement ---

test('the vehicles are laid end to end from the nose backwards', () => {
  const cars = trainCars(straight(10), 5, 200, 'tgv', 'inoui').features;
  assert.ok(cars.length >= 3);
  // Consecutive centres sit half of each vehicle apart: they touch, with no
  // gap to read as a break in the train and no overlap to double the roof.
  for (let i = 0; i < cars.length - 1; i++) {
    const want = (VEHICLE_M[cars[i].properties.role] + VEHICLE_M[cars[i + 1].properties.role]) / 2;
    const got = dist(at(cars[i]), at(cars[i + 1]));
    assert.ok(Math.abs(got - want) < 1, `${got.toFixed(1)} m apart, expected ${want.toFixed(1)}`);
  }
});

test('the leading vehicle is at the front, and it is the only one flagged', () => {
  const cars = trainCars(straight(10), 5, 200, 'tgv', 'inoui').features;
  const lead = cars.filter((f) => f.properties.lead === 1);
  assert.equal(lead.length, 1);
  // North-running track, so the front is the northernmost.
  assert.equal(at(lead[0])[1], Math.max(...cars.map((f) => at(f)[1])));
});

test('the whole train is about as long as it should be', () => {
  const cars = trainCars(straight(10), 5, 200, 'tgv', 'inoui').features;
  const ys = cars.map((f) => at(f)[1]);
  const ends = Math.max(...ys) - Math.min(...ys) + VEHICLE_M.power;
  assert.ok(Math.abs(ends - 200) < 25, `${ends.toFixed(0)} m`);
});

test('on a curve the vehicles turn with the track', () => {
  // This is the whole reason the train is placed vehicle by vehicle.
  const track = curve(0.6);
  const cars = trainCars(track, Math.min(track.length, 1.0), 200, 'ter', 'ter').features;
  const swept = Math.abs(heading(cars[cars.length - 1]) - heading(cars[0]));
  // 200 m of train on a 600 m radius sweeps about 19°.
  assert.ok(swept > 10 && swept < 30, `swept ${swept.toFixed(1)}°`);
});

test('no vehicle strays from the rails on a curve', () => {
  // A single rigid image over this arc would stand about 8 m off at its ends.
  const track = curve(0.6);
  let worst = 0;
  for (const f of trainCars(track, 1.0, 200, 'ter', 'ter').features) {
    const [lon, lat] = f.geometry.coordinates;
    const on = track.at(track.distanceAt(lat, lon));
    worst = Math.max(worst, dist(at(f), xy([on.lon, on.lat])));
  }
  assert.ok(worst < 1, `worst centre ${worst.toFixed(2)} m off the line`);
});

test('the artwork is drawn nose-right, so the bearing is offset a quarter turn', () => {
  // Due north track: the drawing has to be turned to point up the page. The
  // rear cab carries a further half turn, which is taken back out here.
  for (const f of trainCars(straight(10), 5, 200, 'tgv', 'inoui').features) {
    assert.ok(Math.abs(heading(f) + 90) < 1, 'north is -90 to the art');
  }
});

test('each vehicle asks for the drawing of its own kind and livery', () => {
  for (const f of trainCars(straight(10), 5, 190, 'ic', 'ic').features) {
    assert.equal(f.properties.icon, `${f.properties.role}|ic`);
  }
  const ouigo = trainCars(straight(10), 5, 200, 'tgv', 'ouigo').features;
  assert.ok(ouigo.every((f) => f.properties.icon.endsWith('|ouigo')));
});

test('a train just starting out is not drawn off the end of its route', () => {
  // 50 m into the journey there is no route behind it to stand on, so only
  // what fits is drawn rather than vehicles pointing in invented directions.
  const cars = trainCars(straight(10), 0.05, 200, 'tgv', 'inoui').features;
  for (const f of cars) assert.ok(at(f)[1] >= -1, 'nothing behind the start of the line');
  assert.ok(cars.length < consist('tgv', 200).length, 'the rest is left off');
});

test('a train at the very start of the route draws nothing rather than nonsense', () => {
  assert.equal(trainCars(straight(10), 0, 200, 'tgv', 'inoui').features.length, 0);
});

// ------------------------------------------------------------- the artwork ---

test('every vehicle has a drawing', async () => {
  const files = (await readdir(ART_DIR)).filter((f) => f.endsWith('.svg'));
  assert.equal(files.length, Object.keys(VEHICLE_M).length, `drawings: ${files.join(', ')}`);
  for (const name of Object.values(ART_FILE)) {
    assert.ok(files.includes(`${name}.svg`), `${name}.svg is missing`);
  }
});

test('the lengths here match the artwork they are drawn from', async () => {
  // The viewBox is in decimetres, so a 26.4 m coach is 264 units. Two copies
  // of the same number is exactly the kind of thing that drifts apart.
  for (const [role, name] of Object.entries(ART_FILE)) {
    const svg = await readFile(path.join(ART_DIR, `${name}.svg`), 'utf8');
    const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    assert.ok(m, `${name}.svg has no viewBox`);
    assert.equal(Number(m[1]) / 10, VEHICLE_M[role], `${name}.svg length`);
    assert.equal(Number(m[2]) / 10, 2.9, `${name}.svg should be a vehicle's real width`);
  }
});

test('every drawing takes the livery colours', async () => {
  // Untinted artwork renders with the placeholder text as a colour, which
  // browsers treat as black — a train-shaped hole in the map.
  for (const name of Object.values(ART_FILE)) {
    const svg = await readFile(path.join(ART_DIR, `${name}.svg`), 'utf8');
    assert.ok(svg.includes('{{band}}'), `${name}: no flank colour`);
    assert.ok(svg.includes('{{body}}'), `${name}: no roof colour`);
  }
});

test('the drawings are self-contained SVG that a browser can rasterise', async () => {
  for (const name of Object.values(ART_FILE)) {
    const svg = await readFile(path.join(ART_DIR, `${name}.svg`), 'utf8');
    assert.equal([...svg.matchAll(/<svg[\s>]/g)].length, 1, `${name}: one root element`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}: needs a namespace`);
    // No external references: the image is loaded from a data URL, which
    // cannot fetch anything.
    assert.ok(!/xlink:href|<image|url\(http/.test(svg), `${name}: refers to something external`);
  }
});

test('the cab drawings face the way the code expects', async () => {
  // Nose-right is the convention the bearing offset relies on. The nose is
  // where the windscreen is, so it should be in the right-hand half.
  for (const name of ['power-car', 'loco', 'emu-cab']) {
    const svg = await readFile(path.join(ART_DIR, `${name}.svg`), 'utf8');
    const width = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
    const glass = /<path d="M([\d.]+)[^"]*"\s+fill="#16202c"/.exec(svg);
    assert.ok(glass, `${name}: no windscreen found`);
    assert.ok(Number(glass[1]) > width / 2, `${name}: the cab should be at the right-hand end`);
  }
});

test('the vehicle at the back faces backwards', () => {
  // A TGV has a motrice at each end and the rear one is turned round. Without
  // this the back of the train is a nose buried in the coach behind it.
  const cars = trainCars(straight(10), 5, 200, 'tgv', 'inoui').features;
  const rear = cars[cars.length - 1];
  const front = cars[0];
  assert.equal(rear.properties.role, 'power');
  assert.equal(front.properties.role, 'power');
  assert.equal(rear.properties.reversed, 1, 'the rear motrice is turned round');
  assert.equal(front.properties.reversed, 0);
  // Half a turn apart, however the angles are wrapped.
  const gap = Math.abs(((rear.properties.bearing - front.properties.bearing) % 360 + 360) % 360);
  assert.ok(Math.abs(gap - 180) < 1, `${gap.toFixed(1)}° apart`);
});

test('a multiple unit is turned round at the back too', () => {
  const cars = trainCars(straight(10), 5, 80, 'ter', 'ter').features;
  const rear = cars[cars.length - 1];
  assert.equal(rear.properties.role, 'emu-cab');
  assert.equal(rear.properties.reversed, 1);
});

test('a hauled train is not turned round: its back is a coach', () => {
  // An Intercités has one cab, at the front. Reversing the rear vehicle would
  // put a coach's gangway end where its other gangway end already is.
  const cars = trainCars(straight(10), 5, 190, 'ic', 'ic').features;
  assert.ok(cars.every((f) => f.properties.reversed === 0));
  assert.equal(cars[cars.length - 1].properties.role, 'coach', 'a coach at the back');
  assert.equal(cars[0].properties.role, 'loco', 'the loco leads');
});

test('one unit turns exactly one vehicle round', () => {
  const cars = trainCars(straight(10), 5, 400, 'tgv', 'inoui').features;
  assert.equal(cars.filter((f) => f.properties.reversed === 1).length, 1);
});

test('a double TGV is two whole sets, not one stretched one', () => {
  // What you see on the ground: two 200 m trains attached, so four motrices,
  // and the middle two back to back. Drawn as a single set it had a motrice
  // only at each far end with twenty remorques strung between them, which is
  // not a train anyone has ever seen.
  const single = consist('tgv', 200, 24, 1);
  const double = consist('tgv', 400, 24, 2);

  const motrices = (r) => r.filter((v) => v === 'power').length;
  assert.equal(motrices(single), 2, 'a set has one at each end');
  assert.equal(motrices(double), 4, 'and a pair of sets has four');
  assert.deepEqual(double, [...single, ...single], 'it is literally the set twice');
});

test('the two sets of a double meet cab to cab', () => {
  // The rear motrice of the leading set faces backwards in the middle of the
  // formation, which is the whole visual difference between two coupled sets
  // and one long one.
  const cars = trainCars(straight(10), 5, 400, 'tgv', 'inoui', 24, 2).features;
  const reversed = cars.filter((f) => f.properties.reversed === 1);
  assert.equal(reversed.length, 2, 'one at the back of each set');
  for (const f of reversed) assert.equal(f.properties.role, 'power');

  // And the front of the train is never turned, however the units divide.
  const lead = cars.find((f) => f.properties.lead === 1);
  assert.equal(lead.properties.reversed, 0, 'the nose faces the way it is going');
});

test('a coupled multiple unit gets four cabs too', () => {
  // Two Z-TERs joined is the commonest double there is, and it has a cab at
  // each end of each unit — the rule is not a TGV special case.
  const roles = consist('ter', 160, 24, 2);
  assert.equal(roles.filter((r) => r === 'emu-cab').length, 4);
});

test('the vehicle cap is on the train, not on each unit', () => {
  // Otherwise a double set quietly draws twice the limit, and a long one turns
  // back into the hatching the cap exists to prevent.
  assert.ok(consist('tgv', 5000, 12, 2).length <= 12);
  assert.ok(consist('tgv', 5000, 12, 3).length <= 12);
});
