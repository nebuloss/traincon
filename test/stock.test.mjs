// Holding the speed estimate to what could have happened.
//
// The figure shown for a train is not measured — nothing publishes that. It is
// the nominal line-speed profile scaled by how long the timetable allows for
// the leg, which turns "what this line permits" into "what this train is
// managing". The scaling had no ceiling, so a train on a tighter schedule than
// the nominal profile assumes scaled past every real limit: a TER was reported
// at 266 km/h, on a line limited to 220, in stock that cannot exceed 200.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { STOCK_MAX_KMH, plausibleSpeed } = await import(path.join(ROOT, 'src/shared/stock.ts'));

test('a TER cannot do 266', () => {
  // The report this exists for, with the numbers it had.
  assert.equal(plausibleSpeed(266, 'ter', 220), 200);
});

test('the line limit holds even when the stock could go faster', () => {
  // A TGV on classic track is limited by the track.
  assert.equal(plausibleSpeed(300, 'tgv', 160), 160);
});

test('the stock limit holds even where the line allows more', () => {
  // A TER on a 220 line is still a TER.
  assert.equal(plausibleSpeed(220, 'ter', 220), 200);
});

test('a plausible speed is passed through untouched', () => {
  // The cap must not quietly reshape ordinary readings.
  assert.equal(plausibleSpeed(140, 'ter', 160), 140);
  assert.equal(plausibleSpeed(299, 'tgv', 320), 299);
  assert.equal(plausibleSpeed(90, 'ic', 200), 90);
});

test('the stock limit applies with no line speed at all', () => {
  // On a leg with no track geometry there is no line limit to apply, but the
  // train is still the train.
  assert.equal(plausibleSpeed(400, 'ter'), 200);
  assert.equal(plausibleSpeed(400, 'ter', null), 200);
  assert.equal(plausibleSpeed(400, 'tgv', 0), 320);
});

test('a TGV can still do 320, because it does', () => {
  // The cap has to leave the real thing alone: the fleet is cleared for 320
  // on the LGV Est and Sud-Europe-Atlantique, and trains are reported doing it.
  assert.equal(plausibleSpeed(320, 'tgv', 320), 320);
  assert.equal(plausibleSpeed(328, 'tgv', 320), 320, 'and no further');
});

test('a TER 200 can still do 200', () => {
  // Strasbourg to Bâle really does run at 200, and it is one of the two trains
  // this was noticed on. Capping the family at the common 160 would have
  // contradicted a train that was telling the truth.
  assert.equal(plausibleSpeed(200, 'ter', 220), 200);
  assert.ok(STOCK_MAX_KMH.ter >= 200, 'the family maximum, not the usual one');
});

test('an unknown family still gets a ceiling', () => {
  assert.equal(plausibleSpeed(400, 'draisine'), STOCK_MAX_KMH.other);
});

test('nothing comes back negative', () => {
  // A leg with a nonsensical duration can produce one.
  assert.equal(plausibleSpeed(-50, 'ter', 160), 0);
});

test('every family has a limit, and they are ordered as the trains are', () => {
  for (const f of ['tgv', 'ic', 'ter', 'other']) {
    assert.ok(STOCK_MAX_KMH[f] > 0, f);
  }
  assert.ok(STOCK_MAX_KMH.tgv > STOCK_MAX_KMH.ic, 'a TGV outruns a Corail set');
  assert.ok(STOCK_MAX_KMH.ter >= STOCK_MAX_KMH.other);
});
