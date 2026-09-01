// The liveries.
//
// These used to be a palette chosen for legibility, and were checked for
// staying apart under the common colour-vision deficiencies. They are now the
// colours the trains are really painted, so that guarantee is gone by
// construction: inOui, Lyria and ICE are all red because all three really are
// red, and no test should demand otherwise.
//
// What is still worth holding: the pairs a passenger actually compares must
// not collide — an inOui and a OUIGO standing in the same station is the
// whole reason for doing this — and each livery needs two colours that
// contrast, or the artwork has no roof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LIVERY, liveryOf } = await import(path.join(ROOT, 'src/components/TrainIcon.ts'));

const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const apart = (a, b) => {
  const x = srgb(a).map(lin);
  const y = srgb(b).map(lin);
  return Math.hypot(...x.map((v, i) => v - y[i]));
};

const KEYS = Object.keys(LIVERY);

test('every livery has a flank and a roof', () => {
  for (const k of KEYS) {
    assert.match(LIVERY[k].band, /^#[0-9a-f]{6}$/, `${k} band`);
    assert.match(LIVERY[k].body, /^#[0-9a-f]{6}$/, `${k} body`);
  }
});

test('the roof and the flank contrast within a livery', () => {
  // The artwork insets the roof inside the flank; if they match, the drawing
  // is a plain rectangle and all the plan-view detail disappears.
  for (const k of KEYS) {
    const d = apart(LIVERY[k].band, LIVERY[k].body);
    assert.ok(d > 0.15, `${k}: roof and flank only ${d.toFixed(3)} apart`);
  }
});

test('no two liveries are identical', () => {
  const seen = KEYS.map((k) => `${LIVERY[k].band}/${LIVERY[k].body}`);
  assert.equal(new Set(seen).size, KEYS.length);
});

test('a OUIGO does not look like an inOui', () => {
  // The pair this exists for: they are the same trainset in different paint,
  // and telling them apart at a glance is the point.
  assert.ok(apart(LIVERY.ouigo.band, LIVERY.inoui.band) > 0.15, 'flanks differ');
  assert.ok(apart(LIVERY.ouigo.body, LIVERY.inoui.body) > 0.15, 'roofs differ');
});

test('a TER does not look like an Intercités', () => {
  // Both are blue-ish in life, so this is the one that needed care.
  assert.ok(apart(LIVERY.ter.band, LIVERY.ic.band) > 0.08);
});

test('OUIGO is the blue and pink one', () => {
  // "Le train rose et bleu", as its own operator calls it: a blue body with
  // fuchsia doors. Blue roof, pink flank.
  const [r, g, b] = srgb(LIVERY.ouigo.body);
  assert.ok(b > r && b > g, 'the roof should be blue');
  const [pr, pg, pb] = srgb(LIVERY.ouigo.band);
  assert.ok(pr > pg && pb > pg, 'the flank should be pink');
});

test('inOui wears Carmillon, which is a red', () => {
  const [r, g, b] = srgb(LIVERY.inoui.band);
  assert.ok(r > g * 2 && r > b * 2, 'carmine-vermilion, not a pink or an orange');
  // And a pale roof: the body of an inOui set is grey, not coloured.
  const [rr, rg, rb] = srgb(LIVERY.inoui.body);
  assert.ok(rr > 0.7 && rg > 0.7 && rb > 0.7, 'the roof should be pale grey');
});

// ------------------------------------------------------------- the mapping ---

const train = (service, family = 'tgv') => ({ service, family, number: '1', coupledWith: [] });

test('the operator decides the livery, not the family', () => {
  // An inOui and a OUIGO are both `tgv` and are painted nothing like each
  // other, which is exactly why this is keyed on the service.
  assert.equal(liveryOf(train('OUI')), 'inoui');
  assert.equal(liveryOf(train('OGO')), 'ouigo');
  assert.notEqual(liveryOf(train('OUI')), liveryOf(train('OGO')));
});

test('the codes the feed actually sends are all recognised', () => {
  // Taken from a live count: TER, OUI, IC, OGO, LYR, ICE, ICN cover all but a
  // handful of trains.
  for (const [code, want] of [
    ['TER', 'ter'],
    ['OUI', 'inoui'],
    ['IC', 'ic'],
    ['OGO', 'ouigo'],
    ['LYR', 'lyria'],
    ['ICE', 'ice'],
    ['ICN', 'icn'],
  ]) {
    assert.equal(liveryOf(train(code, 'tgv')), want, code);
  }
});

test('an unknown code falls back to the family, not to nothing', () => {
  // The feed also sends TT, NAV and TRN, which name no livery.
  assert.equal(liveryOf(train('TT', 'ter')), 'ter');
  assert.equal(liveryOf(train('NAV', 'tgv')), 'inoui', 'an unnamed TGV is likeliest an inOui');
  assert.equal(liveryOf(train('TRN', 'other')), 'other');
  assert.ok(LIVERY[liveryOf({ family: 'other', number: '1', coupledWith: [] })], 'no service at all');
});
