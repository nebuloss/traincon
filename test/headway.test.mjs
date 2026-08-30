// Trains cannot occupy the same block.
//
// Positions are estimated per train, from its own timetable and its own delay,
// so nothing stops two of them being drawn on the same piece of track: a fast
// train catching a slower one is shown closing right up to it. In reality it is
// held a block short and slowed — a regular sight between Bordeaux and Dax.
//
// Note what this is not: SNCF does not publish signal positions (the dataset
// named for them is a computer-vision corpus, no coordinates), so this is not a
// claim about which signal is at danger. It is the weaker and still true claim
// that a train cannot be where another one already is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { analyseTraffic, headingGap } = await import(path.join(ROOT, 'dist-server/server/Headway.js'));
const { BlockIndex, blockLengthFor } = await import(path.join(ROOT, 'dist-server/server/Blocks.js'));

/** A train running between stops, `km` north of a base point. */
function running(number, line, km, progress, bearing = 0) {
  return {
    number,
    line,
    position: {
      basis: 'between',
      lat: 44 + km / 111.32,
      lon: -0.5,
      bearing,
      progress,
      speedKmh: 160,
    },
  };
}

/** Two kilometres of block everywhere. */
const twoKm = () => 2000;

test('a train closing on the one ahead is held back', () => {
  // 8542 is 800 m ahead of 8540 on the same line, both northbound.
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 0.8, 0.5)], twoKm);

  const follower = t.get('8540');
  assert.equal(follower.ahead, '8542');
  assert.equal(follower.aspect, 'semaphore', 'the block ahead is occupied');
  assert.ok(follower.pushedM > 1000 && follower.pushedM < 1300, `pushed ${follower.pushedM} m`);

  // The leader has nothing in front of it.
  assert.equal(t.get('8542').aspect, 'libre');
  assert.equal(t.get('8542').pushedM, undefined);
});

test('one block clear reads as a warning, not as clear', () => {
  // 3 km behind on 2 km blocks: the section ahead is empty, but the one after
  // it is not, so the signal in front of this train warns.
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 3, 0.5)], twoKm);
  assert.equal(t.get('8540').aspect, 'avertissement');
  assert.equal(t.get('8540').pushedM, undefined, 'a clear block needs no correction');
});

test('two blocks clear reads as clear', () => {
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 6, 0.5)], twoKm);
  assert.equal(t.get('8540').aspect, 'libre');
  assert.equal(t.get('8540').pushedM, undefined);
});

test('the train in front is never held by the one behind', () => {
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 0.5, 0.6)], twoKm);
  assert.equal(t.get('8542').pushedM, undefined, 'the leader must not be pushed by its follower');
  assert.equal(t.get('8542').ahead, undefined);
});

test('trains going opposite ways do not constrain each other', () => {
  // Two tracks, one each way: they pass, they do not queue.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4, 0), running('9001', 'L1', 0.5, 0.5, 180)],
    twoKm,
  );
  for (const v of t.values()) assert.equal(v.pushedM, undefined, 'passing is not following');
});

test('trains on different lines do not constrain each other', () => {
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('7000', 'L2', 0.4, 0.5)], twoKm);
  for (const v of t.values()) assert.equal(v.ahead, undefined);
});

test('a train standing in a station is not held', () => {
  const stopped = running('8540', 'L1', 0, 0.4);
  stopped.position.basis = 'at_station';
  const t = analyseTraffic([stopped, running('8542', 'L1', 0.5, 0.5)], twoKm);
  assert.ok(!t.has('8540'), 'where the timetable puts it is where it is');
});

test('the tightest constraint wins when several are ahead', () => {
  const held = analyseTraffic(
    [
      running('8540', 'L1', 0, 0.3),
      running('8542', 'L1', 1.5, 0.5),
      running('8544', 'L1', 0.6, 0.4), // closer, so this is the binding one
    ],
    twoKm,
  );
  assert.equal(held.get('8540').ahead, '8544');
});

test('trains far apart on a long line are not paired', () => {
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 120, 0.5)], twoKm);
  assert.equal(t.get('8540').ahead, undefined, '120 km apart is not following');
});

test('nothing is held where there is no block working', () => {
  // "Sans cantonnement" means no spacing to enforce; inventing one would be
  // worse than leaving the estimate alone.
  const t = analyseTraffic([running('8540', 'L1', 0, 0.4), running('8542', 'L1', 0.2, 0.5)], () => 0);
  assert.equal(t.get('8540').pushedM, undefined);
  assert.equal(t.get('8540').aspect, 'inconnu', 'no signalling modelled means no claim');
});

test('headings wrap correctly around north', () => {
  assert.equal(headingGap(350, 10), 20);
  assert.equal(headingGap(10, 350), 20);
  assert.equal(headingGap(0, 180), 180);
});

// ── block lengths from the published working mode ────────────────────────────

test('each published mode maps to a plausible spacing', () => {
  assert.equal(blockLengthFor('Block automatique lumineux'), 1800);
  assert.equal(blockLengthFor('Block automatique lumineux de voie banalisée'), 1800);
  assert.equal(blockLengthFor('Transmission voie-machine 430'), 1500);
  assert.equal(blockLengthFor('Sans cantonnement'), 0);
  assert.ok(blockLengthFor('Block automatique à permissivité restreinte de voie unique') > 5000);
  assert.ok(blockLengthFor('Cantonnement téléphonique de voie unique') > 10000);
});

test('an unrecognised mode is not guessed at', () => {
  assert.equal(blockLengthFor('_Autre'), null);
  assert.equal(blockLengthFor(undefined), null);
});

test('the index answers by line and kilometre post', () => {
  const idx = new BlockIndex([
    { code_ligne: '570000', libelle: 'Block automatique lumineux', pkd: '010+000', pkf: '050+000' },
    {
      code_ligne: '570000',
      libelle: 'Cantonnement téléphonique de voie unique',
      pkd: '050+000',
      pkf: '090+000',
    },
  ]);

  assert.equal(idx.spacingFor('570000', 20, 30), 1800, 'inside the lit-block section');
  assert.equal(idx.spacingFor('570000', 60, 70), 20000, 'inside the telephone section');
  // Spanning both: the longer block binds, since a train must clear it all.
  assert.equal(idx.spacingFor('570000', 40, 60), 20000);
});

test('an unknown line falls back rather than failing', () => {
  const idx = new BlockIndex([]);
  assert.ok(idx.spacingFor('999999', 1, 2) > 0, 'a default block, not zero');
  assert.ok(idx.spacingFor(undefined, null, null) > 0);
});


// ── slowing for a signal ─────────────────────────────────────────────────────

const { approachSpeed } = await import(path.join(ROOT, 'dist-server/server/Headway.js'));

test('the approach follows the parabolic law', () => {
  // v = sqrt(2·a·d) at 0.5 m/s²: 1800 m gives 42 m/s, about 152 km/h.
  assert.ok(Math.abs(approachSpeed(1800, 300) - 152) < 2, `${approachSpeed(1800, 300)}`);
  // Four times the distance, twice the speed — the signature of the law.
  const near = approachSpeed(500, 300);
  const far = approachSpeed(2000, 300);
  assert.ok(Math.abs(far / near - 2) < 0.02, `${near} -> ${far}`);
});

test('a train slows the closer it gets', () => {
  let last = Infinity;
  for (const d of [4000, 3000, 2000, 1000, 500, 200, 50]) {
    const v = approachSpeed(d, 300);
    assert.ok(v < last, `${d} m allowed ${v}, not less than ${last}`);
    last = v;
  }
});

test('at the signal itself the train is stopped', () => {
  assert.equal(approachSpeed(0, 300), 0);
  assert.equal(approachSpeed(-500, 300), 0, 'past it, and certainly stopped');
});

test('a signal never licenses a train to go faster', () => {
  // Ten kilometres of clear track does not entitle a 90 km/h train to 500.
  assert.equal(approachSpeed(10_000, 90), 90);
});

test('coming off a restriction, speed returns quickly then gently', () => {
  // A square root, so for each further kilometre of clearance the train gains
  // less than it did for the last. Compared over equal steps — over doublings
  // the absolute gain grows, which is the curve behaving, not misbehaving.
  const early = approachSpeed(2000, 300) - approachSpeed(1000, 300);
  const late = approachSpeed(4000, 300) - approachSpeed(3000, 300);
  assert.ok(early > late, `gained ${early.toFixed(0)} then ${late.toFixed(0)} km/h per km`);
});

test('an approach to a restriction rather than a stop keeps that speed', () => {
  // Slowing to 80 rather than to a stand.
  assert.ok(approachSpeed(0, 300, 80) === 80, 'at the board, exactly the restriction');
  assert.ok(approachSpeed(1000, 300, 80) > 80, 'and more before reaching it');
});

test('the reported allowance appears only when it bites', () => {
  // Two blocks clear at 160 km/h: the braking curve permits more than the
  // train is doing, so there is nothing to report.
  const far = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), running('8542', 'L1', 8, 0.5)],
    twoKm,
  );
  assert.equal(far.get('8540').allowedKmh, undefined);

  // Closing to within a block and a half, it does bite.
  const near = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), running('8542', 'L1', 2.4, 0.5)],
    twoKm,
  );
  const t = near.get('8540');
  assert.ok(t.allowedKmh < 160, `allowed ${t.allowedKmh} of 160`);
  assert.ok(t.allowedKmh > 0);
});


test('two halves of a coupled train do not hold each other back', () => {
  // Seen in production: 12177 and 5537 are one train, Strasbourg to Nice,
  // drawn at the same point because they are in the same place. Without this
  // one of them was pushed a block back for running into itself.
  const a = running('12177', 'L1', 0, 0.5);
  const b = running('5537', 'L1', 0, 0.5);
  a.coupledWith = ['5537'];
  b.coupledWith = ['12177'];

  const t = analyseTraffic([a, b], twoKm);
  assert.equal(t.get('12177').pushedM, undefined, 'a train cannot follow itself');
  assert.equal(t.get('12177').ahead, undefined);
  assert.equal(t.get('5537').pushedM, undefined);
});

test('the exclusion holds even if only one side records the coupling', () => {
  const a = running('12177', 'L1', 0, 0.4);
  const b = running('5537', 'L1', 0.3, 0.6);
  a.coupledWith = ['5537'];
  // b.coupledWith deliberately left unset.
  const t = analyseTraffic([a, b], twoKm);
  assert.equal(t.get('12177').pushedM, undefined);
});

test('an ordinary follower is still held when a coupled set is nearby', () => {
  const a = running('12177', 'L1', 0, 0.5);
  const b = running('5537', 'L1', 0, 0.5);
  a.coupledWith = ['5537'];
  b.coupledWith = ['12177'];
  // A genuine third train closing on them.
  const c = running('9999', 'L1', -0.8, 0.3);

  const t = analyseTraffic([a, b, c], twoKm);
  assert.ok(t.get('9999').pushedM > 0, 'a real follower must still be held');
  assert.ok(['12177', '5537'].includes(t.get('9999').ahead));
});


// ── single track ─────────────────────────────────────────────────────────────

const SINGLE = () => ({ single: true, tracks: 1 });
const DOUBLE = () => ({ single: false, tracks: 2 });

/** Same as `running`, but pointed the other way. */
function facing(number, line, km, progress) {
  return running(number, line, km, progress, 180);
}

test('on single track, trains meeting head-on constrain each other', () => {
  // Neither is "ahead" of the other in any useful sense — they simply cannot
  // both continue.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), facing('9001', 'L1', 1.5, 0.5)],
    twoKm,
    undefined,
    SINGLE,
  );
  assert.equal(t.get('8540').aspect, 'semaphore');
  assert.equal(t.get('8540').opposing, true);
  assert.equal(t.get('8540').ahead, '9001');
  assert.equal(t.get('9001').opposing, true, 'both are constrained, not just one');
});

test('on double track, the same pair is ignored', () => {
  // Two tracks, one each way: they pass, which is the whole point of two.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), facing('9001', 'L1', 1.5, 0.5)],
    twoKm,
    undefined,
    DOUBLE,
  );
  assert.equal(t.get('8540').opposing, undefined);
  assert.equal(t.get('8540').pushedM, undefined);
});

test('neither opposing train is moved, because which one waits is unknowable', () => {
  // One of them is standing in a passing loop. The timetable does not say
  // which, and inventing an answer would put a train where it is not.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), facing('9001', 'L1', 1, 0.5)],
    twoKm,
    undefined,
    SINGLE,
  );
  assert.equal(t.get('8540').pushedM, undefined);
  assert.equal(t.get('9001').pushedM, undefined);
});

test('an opposing train slows for the meeting point', () => {
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), facing('9001', 'L1', 0.6, 0.5)],
    twoKm,
    undefined,
    SINGLE,
  );
  const a = t.get('8540');
  assert.ok(a.allowedKmh < 160, `allowed ${a.allowedKmh} of 160`);
  assert.ok(a.allowedKmh >= 0);
});

test('a distant opposing train on single track is not a constraint', () => {
  // Twenty kilometres apart with two-kilometre blocks: there is a loop between
  // them, and treating that as a conflict would freeze half the network.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), facing('9001', 'L1', 20, 0.5)],
    twoKm,
    undefined,
    SINGLE,
  );
  assert.equal(t.get('8540').opposing, undefined);
});

test('following still works on single track', () => {
  // Same direction, single track: the ordinary following rule applies.
  const t = analyseTraffic(
    [running('8540', 'L1', 0, 0.4), running('8542', 'L1', 0.8, 0.5)],
    twoKm,
    undefined,
    SINGLE,
  );
  assert.equal(t.get('8540').ahead, '8542');
  assert.ok(t.get('8540').pushedM > 0, 'a follower is still held back');
  assert.equal(t.get('8540').opposing, undefined);
});

test('coupled halves are excluded on single track too', () => {
  const a = running('12177', 'L1', 0, 0.5);
  const b = running('5537', 'L1', 0, 0.5);
  a.coupledWith = ['5537'];
  b.coupledWith = ['12177'];
  const t = analyseTraffic([a, b], twoKm, undefined, SINGLE);
  assert.equal(t.get('12177').opposing, undefined);
  assert.equal(t.get('12177').pushedM, undefined);
});
