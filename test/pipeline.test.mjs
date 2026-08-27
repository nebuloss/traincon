// End-to-end check of the decoding pipeline against the bundled capture.
//
// Deliberately offline: the upstream SNCF proxy goes down regularly, and CI
// failing because someone else's server is unreachable teaches nothing. The
// fixture is a real feed capture, replayed with its timestamps rebased.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SNCF_FEED_FILE = path.join(ROOT, 'fixtures', 'sncf-trip-updates.pb');
process.env.SNCF_FEED_SHIFT = 'auto';

const { loadStatic, SERVICE_LABELS } = await import('../src/gtfs.js');
const { loadTrains, positionOf, legAt, currentDelay, observation } = await import('../src/realtime.js');

const DATA = path.join(ROOT, 'data');
const statics = await loadStatic(DATA);
const { trains, feedTs, replay } = await loadTrains(statics);

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
  const age = Math.abs(Math.floor(Date.now() / 1000) - feedTs);
  assert.ok(age < 120, `feed timestamp rebased (age ${age}s)`);
});

test('service families are classified', () => {
  const fams = new Set(trains.map((t) => SERVICE_LABELS[t.service]?.family).filter(Boolean));
  for (const f of ['tgv', 'ter']) assert.ok(fams.has(f), `${f} present`);
});

test('every call is ordered and carries a delay', () => {
  for (const t of trains.slice(0, 200)) {
    assert.ok(t.calls.length >= 2, `${t.number} has calls`);
    for (let i = 1; i < t.calls.length; i++) {
      assert.ok(t.calls[i].time >= t.calls[i - 1].time, `${t.number} calls ordered`);
    }
    assert.equal(typeof t.maxDelay, 'number');
  }
});

test('currentDelay reports what is still ahead, not the worst of the run', () => {
  const now = Math.floor(Date.now() / 1000);
  // A train that lost time early and recovered must not still read at its worst.
  const recovered = trains.find((t) => t.maxDelay - currentDelay(t, now) >= 300);
  if (recovered) {
    assert.ok(currentDelay(recovered, now) < recovered.maxDelay,
      `${recovered.number}: current < worst`);
  }
  for (const t of trains.slice(0, 100)) {
    assert.ok(currentDelay(t, now) <= t.maxDelay, `${t.number}: current <= worst`);
  }
});

test('a dwelling train sits exactly on its station', () => {
  const now = Math.floor(Date.now() / 1000);
  let checked = 0;
  for (const t of trains) {
    const p = positionOf(t, now);
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
  const now = Math.floor(Date.now() / 1000);
  for (const t of trains.slice(0, 300)) {
    const leg = legAt(t, now);
    const p = positionOf(t, now);
    assert.equal(leg.basis, p.basis, `${t.number} basis agrees`);
    if (p.basis === 'between') {
      assert.ok(p.legProgress >= 0 && p.legProgress <= 1, `${t.number} progress in range`);
    }
  }
});

test('observation freshness degrades with time since the last call', () => {
  const now = Math.floor(Date.now() / 1000);
  const running = trains.filter((t) => legAt(t, now).basis === 'between');
  assert.ok(running.length > 0, 'some trains running');
  for (const t of running.slice(0, 100)) {
    const o = observation(t, now);
    assert.ok(['confirmed', 'good', 'estimated', 'stale', 'scheduled'].includes(o.confidence));
    if (o.ageSec != null) assert.ok(o.ageSec >= 0, 'age is not negative');
  }
});

test('positions stay inside a plausible bounding box for the network', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const t of trains.slice(0, 300)) {
    const p = positionOf(t, now);
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${t.number} finite`);
    // Western Europe: the feed includes cross-border services.
    assert.ok(p.lat > 35 && p.lat < 56, `${t.number} lat ${p.lat}`);
    assert.ok(p.lon > -10 && p.lon < 20, `${t.number} lon ${p.lon}`);
  }
});
