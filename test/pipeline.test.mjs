// End-to-end check of the decoding pipeline against the bundled capture.
//
// Deliberately offline: the upstream SNCF proxy goes down regularly, and CI
// failing because someone else's server is unreachable teaches nothing. The
// fixture is a real feed capture, replayed with its timestamps rebased.
//
// Runs against the compiled output, so `npm run build` must precede it — which
// also means the type checker has passed before any of this executes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SNCF_FEED_FILE = path.join(ROOT, 'fixtures', 'sncf-trip-updates.pb');
process.env.SNCF_FEED_SHIFT = 'auto';

const { GtfsStatic, serviceMeta } = await import('../dist-server/server/GtfsStatic.js');
const { FeedClient } = await import('../dist-server/server/FeedClient.js');
const { Train } = await import('../dist-server/server/Train.js');
const { CouplingDetector } = await import('../dist-server/server/CouplingDetector.js');

const statics = await GtfsStatic.load(path.join(ROOT, 'data'));
const { trains: raw, feedTs, replay } = await new FeedClient().load(statics);
const trains = raw.map((r) => new Train(r));
const now = Math.floor(Date.now() / 1000);

test('static GTFS loads stations and train metadata', () => {
  assert.ok(statics.stops.size > 5000, 'stops');
  assert.ok(statics.stations.size > 2000, 'stations grouped by UIC');
  assert.ok(statics.trains.size > 5000, 'train numbers');

  // A station exists under several stop_ids (one per operator); they must be
  // collapsed onto one UIC or a departure board shows a single operator.
  const dax = [...statics.stations.values()].find((s) => s.name.toUpperCase() === 'DAX');
  assert.ok(dax, 'Dax present');
  assert.ok(dax.stopIds.length > 1, 'Dax groups several stop_ids');
});

test('replay mode decodes the capture and rebases it onto now', () => {
  assert.equal(replay, true, 'flagged as replay');
  assert.ok(trains.length > 500, `${trains.length} trains decoded`);
  assert.ok(Math.abs(now - feedTs) < 120, 'feed timestamp rebased');
});

test('service families are classified', () => {
  const fams = new Set(trains.map((t) => serviceMeta(t.service).family));
  for (const f of ['tgv', 'ter']) assert.ok(fams.has(f), `${f} present`);
});

test('every call is ordered and carries a delay', () => {
  for (const t of trains.slice(0, 200)) {
    assert.ok(t.calls.length >= 2, `${t.number} has calls`);
    for (let i = 1; i < t.calls.length; i++) {
      assert.ok(t.calls[i].time >= t.calls[i - 1].time, `${t.number} calls ordered`);
    }
    assert.equal(typeof t.worstDelay, 'number');
  }
});

test('currentDelay reports what is still ahead, not the worst of the run', () => {
  // A train that lost time early and recovered must not still read at its worst.
  const recovered = trains.find((t) => t.worstDelay - t.currentDelay(now) >= 300);
  if (recovered) {
    assert.ok(recovered.currentDelay(now) < recovered.worstDelay, 'current < worst');
  }
  for (const t of trains.slice(0, 100)) {
    assert.ok(t.currentDelay(now) <= t.worstDelay, `${t.number}: current <= worst`);
  }
});

test('a dwelling train sits exactly on its station', () => {
  let checked = 0;
  for (const t of trains) {
    const p = t.positionAt(now);
    if (p.basis !== 'at_station') continue;
    const call = t.calls.find((c) => c.name === p.atStation);
    if (!call) continue;
    assert.ok(Math.abs(p.lat - call.lat) < 1e-6, `${t.number} lat on station`);
    assert.ok(Math.abs(p.lon - call.lon) < 1e-6, `${t.number} lon on station`);
    if (++checked >= 20) break;
  }
  assert.ok(checked > 0, 'at least one dwelling train found');
});

test('leg selection is consistent with the position basis', () => {
  for (const t of trains.slice(0, 300)) {
    const leg = t.legAt(now);
    const p = t.positionAt(now);
    assert.equal(leg.basis, p.basis, `${t.number} basis agrees`);
    if (p.basis === 'between') {
      assert.ok(p.legProgress >= 0 && p.legProgress <= 1, `${t.number} progress in range`);
    }
  }
});

test('observation freshness degrades with time since the last call', () => {
  const running = trains.filter((t) => t.legAt(now).basis === 'between');
  assert.ok(running.length > 0, 'some trains running');
  for (const t of running.slice(0, 100)) {
    const o = t.observation(now);
    assert.ok(['confirmed', 'good', 'estimated', 'stale', 'scheduled'].includes(o.confidence));
    if (o.ageSec != null) assert.ok(o.ageSec >= 0, 'age is not negative');
  }
});

test('positions stay inside a plausible bounding box for the network', () => {
  for (const t of trains.slice(0, 300)) {
    const p = t.positionAt(now);
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${t.number} finite`);
    // Western Europe: the feed includes cross-border services.
    assert.ok(p.lat > 35 && p.lat < 56, `${t.number} lat ${p.lat}`);
    assert.ok(p.lon > -10 && p.lon < 20, `${t.number} lon ${p.lon}`);
  }
});

test('coupled sets share one position and one reconciled delay', () => {
  const res = new CouplingDetector().detect(trains, now, null);
  for (const [number, partners] of res.partners) {
    assert.ok(partners.length >= 1, `${number} has partners`);
    const pos = res.positions.get(number);
    assert.ok(pos, `${number} has a shared position`);
    // Every member of a set must be placed identically: one physical train.
    for (const p of partners) {
      const other = res.positions.get(p);
      assert.ok(other, `${p} has a position`);
      assert.equal(other.lat, pos.lat, `${number}/${p} same lat`);
      assert.equal(other.lon, pos.lon, `${number}/${p} same lon`);
      assert.equal(res.delays.get(p)?.delay, res.delays.get(number)?.delay, 'same delay');
    }
  }
});
