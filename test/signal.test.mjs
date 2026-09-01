// The deduced signal, drawn as a French signal.
//
// The distinction these protect is the one that matters on the ground: a
// sémaphore is a stop you may pass at caution after standing, a carré is an
// absolute stop you may not pass at all. Both are red. Drawn as one coloured
// dot they are the same picture.
//
// The head is the SNCF three-lamp target: green on top, red in the middle,
// yellow at the bottom — not the road traffic-light stack. A carré-capable target carries
// five and lights two non-adjacent reds for a carré, but at the size this is
// shown five lenses leave each a few pixels across — so the two stop aspects
// are told apart by the œilleton instead, which is how they are told apart on
// the ground anyway.
//
// The spacing is the one thing kept from the real drawings: 1.6 times the
// lamp diameter between centres. An earlier version used 1.1, so consecutive
// lenses overlapped and the positions ran together. Hence the geometry checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { signalKey } = await import(path.join(ROOT, 'src/core/SignalArt.ts'));

const ART_DIR = path.join(ROOT, 'src/assets/signal');
const KEYS = ['vl', 'a', 'semaphore', 'carre'];
const art = Object.fromEntries(
  await Promise.all(
    KEYS.map(async (k) => [k, await readFile(path.join(ART_DIR, `${k}.svg`), 'utf8')]),
  ),
);

const RED = '#ff1a1a';
const GREEN = '#22dd55';
const YELLOW = '#ffd400';
const DARK = '#333333';
const WHITE = '#f4f6fa';

/** The lamps: the r=5 circles, which are the lenses themselves. */
const lamps = (svg) =>
  [...svg.matchAll(/<circle cx="22" cy="([\d.]+)" r="5" fill="(#[0-9a-f]{6})"/g)]
    .map((m) => ({ cy: Number(m[1]), fill: m[2] }))
    .sort((a, b) => a.cy - b.cy);

/** The three lamp positions of an SNCF head: green, red, yellow, top down. */
const ROWS = { 26: 'green', 42: 'red', 58: 'yellow' };
const litRows = (svg, colour) =>
  lamps(svg)
    .filter((l) => l.fill === colour)
    .map((l) => ROWS[l.cy]);

// ------------------------------------------------------------ the aspects ---

test('voie libre is one green, at the top', () => {
  assert.deepEqual(litRows(art.vl, GREEN), ['green']);
  assert.equal(litRows(art.vl, RED).length, 0, 'nothing red');
  assert.equal(litRows(art.vl, YELLOW).length, 0, 'nothing yellow');
});

test('avertissement is one yellow, at the bottom', () => {
  assert.deepEqual(litRows(art.a, YELLOW), ['yellow']);
  assert.equal(litRows(art.a, GREEN).length, 0, 'nothing green');
});

test('both stop aspects are one red, in the middle', () => {
  assert.deepEqual(litRows(art.semaphore, RED), ['red']);
  assert.deepEqual(litRows(art.carre, RED), ['red']);
});

test('the lamps are in the SNCF order, not the road one', () => {
  // Green on top, red in the middle, yellow at the bottom. A semaphore-only
  // target carries the lower three of the five positions on a full head —
  // green at 79, red at 95, yellow at 111 — and that is the order here.
  // Drawing the familiar road stack instead would be a signal that does not
  // exist.
  for (const [name, svg] of Object.entries(art)) {
    assert.deepEqual(
      lamps(svg).map((l) => ROWS[l.cy]),
      ['green', 'red', 'yellow'],
      name,
    );
  }
});

test('the œilleton is what tells a carré from a sémaphore', () => {
  // Both are one red here, so the small white light on the support carries
  // the whole distinction — which is how it works on the ground, and on some
  // installations the only visible difference there too.
  assert.match(art.semaphore, new RegExp(`cy="72" r="3.5" fill="${WHITE}"`), 'sémaphore: lit');
  assert.match(art.carre, new RegExp(`cy="72" r="3.5" fill="${DARK}"`), 'carré: out');
  // And the two must not be identical in any other respect either.
  assert.notEqual(art.semaphore, art.carre);
});

test('only a stop aspect carries an œilleton at all', () => {
  // On a green or a yellow it would say something about permissiveness that
  // has nothing to do with the aspect being shown.
  for (const k of ['vl', 'a']) assert.ok(!art[k].includes('cy="72"'), `${k} should not have one`);
});

// ----------------------------------------------------------- the geometry ---

test('the lamps are spaced well clear of each other', () => {
  // The fault this replaced: lamps spaced closer than their own diameter, so
  // the positions could not be told apart. The real drawings use 16 between
  // centres for a radius of 5 — 1.6 diameters.
  for (const [name, svg] of Object.entries(art)) {
    const ys = lamps(svg).map((l) => l.cy);
    for (let i = 0; i < ys.length - 1; i++) {
      const gap = ys[i + 1] - ys[i];
      assert.equal(gap, 16, `${name}: lamps ${gap} apart`);
      assert.ok(gap / 10 > 1.5, `${name}: only ${gap / 10} diameters apart`);
      assert.ok(gap - 10 >= 5, `${name}: only ${gap - 10} units of black between lenses`);
    }
  }
});

test('every lamp sits inside its target', () => {
  for (const [name, svg] of Object.entries(art)) {
    const panel = /<rect x="5" y="([\d.]+)" width="34" height="([\d.]+)"/.exec(svg);
    assert.ok(panel, `${name}: no target`);
    const top = Number(panel[1]);
    const bottom = top + Number(panel[2]);
    for (const l of lamps(svg)) {
      assert.ok(l.cy - 5 >= top, `${name}: a lamp above the target`);
      assert.ok(l.cy + 5 <= bottom, `${name}: a lamp below the target`);
    }
  }
});

test('the mast and base are identical everywhere', () => {
  // Only the target changes height; if the mast moved too the signal would
  // jump about as the aspect changed.
  const fixed = (svg) => [...svg.matchAll(/<rect x="(?:12|18\.5)"[^>]*>/g)].join('|');
  assert.equal(new Set(KEYS.map((k) => fixed(art[k]))).size, 1);
});

test('the target is black with a white surround, as it is on the ground', () => {
  for (const [name, svg] of Object.entries(art)) {
    assert.match(svg, /fill="#0c0c0e" stroke="#eef1f5"/, `${name}: target`);
  }
});

test('unlit lamps are drawn, not left out', () => {
  // A real target shows its dark lenses; a single floating lamp would not
  // look like a signal.
  for (const [name, svg] of Object.entries(art)) {
    assert.ok(lamps(svg).some((l) => l.fill === DARK), `${name}: no dark lenses`);
  }
});

test('the drawings are self-contained and decorative', async () => {
  const files = (await readdir(ART_DIR)).filter((f) => f.endsWith('.svg'));
  assert.equal(files.length, KEYS.length, `drawings: ${files.join(', ')}`);
  for (const [name, svg] of Object.entries(art)) {
    assert.equal([...svg.matchAll(/<svg[\s>]/g)].length, 1, `${name}: one root`);
    assert.match(svg, /viewBox="0 0 44 86"/, `${name}: one size for all`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}: needs a namespace`);
    // The label lives on the wrapper, so the drawing must not announce itself.
    assert.match(svg, /aria-hidden="true"/, `${name}: should be decorative`);
    assert.ok(!/xlink:href|<image|url\(http/.test(svg), `${name}: refers to something external`);
  }
});

// ------------------------------------------------------------- the picking ---

test('the aspect picks the lamp, and the signal kind picks between the two reds', () => {
  assert.equal(signalKey('libre', 'carre'), 'vl');
  assert.equal(signalKey('libre', 'semaphore'), 'vl');
  assert.equal(signalKey('avertissement', 'carre'), 'a');
  assert.equal(signalKey('semaphore', 'carre'), 'carre');
  assert.equal(signalKey('semaphore', 'semaphore'), 'semaphore');
});

test('a head has three lamps', () => {
  for (const [name, svg] of Object.entries(art)) assert.equal(lamps(svg).length, 3, name);
});

test('a signal of unknown kind gets the commoner one', () => {
  // A sémaphore is far commoner on plain line, and its drawing is the one
  // that does not assert an absolute stop.
  assert.equal(signalKey('semaphore'), 'semaphore');
  assert.equal(signalKey('libre'), 'vl');
  assert.equal(signalKey('avertissement'), 'a');
});

test('an unknown aspect draws nothing', () => {
  // An unlit head would be a claim that the signal is dark, which is a real
  // and serious aspect of its own.
  assert.equal(signalKey('inconnu'), null);
});

test('every key the picker can return has a drawing', () => {
  for (const aspect of ['libre', 'avertissement', 'semaphore', 'inconnu']) {
    for (const kind of ['carre', 'semaphore', undefined]) {
      const k = signalKey(aspect, kind);
      if (k !== null) assert.ok(art[k], `no drawing for ${k}`);
    }
  }
});
