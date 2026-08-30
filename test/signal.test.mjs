// The deduced signal, drawn as a French signal.
//
// The distinction these protect is the one that matters on the ground: a
// sémaphore is a stop you may pass at caution after standing, a carré is an
// absolute stop you may not pass at all. Both are red. Drawn as one coloured
// dot they are the same picture.
//
// The layout came from the RFN signalling drawings (see the README beside the
// artwork), and two things in it were not what anyone would guess: the
// carré's two reds are not adjacent, and the lamps are spaced more than one
// and a half times their own diameter apart. The version before it had them
// spaced 1.1 apart, so consecutive lenses overlapped and the positions ran
// together, and it lit two adjacent lamps for the carré. Hence these.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { signalKey } = await import(path.join(ROOT, 'src/client/core/SignalArt.ts'));

const ART_DIR = path.join(ROOT, 'src/client/assets/signal');
const KEYS = ['vl', 'a', 'semaphore', 'vl-carre', 'a-carre', 'carre'];
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

/** Which of the five standard positions a lamp sits at, 1 at the top. */
const ROWS = { 26: 1, 42: 2, 58: 3, 74: 4, 90: 5 };
const litRows = (svg, colour) =>
  lamps(svg)
    .filter((l) => l.fill === colour)
    .map((l) => ROWS[l.cy]);

// ------------------------------------------------------------ the aspects ---

test('voie libre is one green, at the third position', () => {
  for (const k of ['vl', 'vl-carre']) {
    assert.deepEqual(litRows(art[k], GREEN), [3], k);
    assert.equal(litRows(art[k], RED).length, 0, `${k}: nothing red`);
    assert.equal(litRows(art[k], YELLOW).length, 0, `${k}: nothing yellow`);
  }
});

test('avertissement is one yellow, at the bottom', () => {
  for (const k of ['a', 'a-carre']) {
    assert.deepEqual(litRows(art[k], YELLOW), [5], k);
    assert.equal(litRows(art[k], GREEN).length, 0, `${k}: nothing green`);
  }
});

test('a sémaphore is one red, at the fourth position', () => {
  assert.deepEqual(litRows(art.semaphore, RED), [4]);
});

test('a carré is two reds, and they are not adjacent', () => {
  // Positions 1 and 4, with a dark lamp between them. Lighting two lamps next
  // to each other would be a signal that does not exist.
  assert.deepEqual(litRows(art.carre, RED), [1, 4]);
  const between = lamps(art.carre).filter((l) => ROWS[l.cy] === 2 || ROWS[l.cy] === 3);
  assert.ok(between.every((l) => l.fill === DARK), 'the lamps between them are out');
});

test('the œilleton is lit on a sémaphore and out on a carré', () => {
  // The small white light on the support is what says a signal may be passed.
  // It is extinguished when a carré is closed, and on some installations that
  // is the only visible difference between the two.
  assert.match(art.semaphore, new RegExp(`cy="104" r="3.5" fill="${WHITE}"`), 'sémaphore: lit');
  assert.match(art.carre, new RegExp(`cy="104" r="3.5" fill="${DARK}"`), 'carré: out');
});

test('only a stop aspect carries an œilleton at all', () => {
  // On a green or a yellow it would say something about permissiveness that
  // has nothing to do with the aspect being shown.
  for (const k of ['vl', 'a', 'vl-carre', 'a-carre']) {
    assert.ok(!art[k].includes('cy="104"'), `${k} should not have one`);
  }
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
    }
  }
});

test('a carré-capable target carries five lamps, a sémaphore three', () => {
  // A signal that can only show a sémaphore is physically shorter, and these
  // are drawn that way rather than padded to match.
  for (const k of ['carre', 'vl-carre', 'a-carre']) assert.equal(lamps(art[k]).length, 5, k);
  for (const k of ['semaphore', 'vl', 'a']) assert.equal(lamps(art[k]).length, 3, k);
});

test('the shorter target holds the lower three positions', () => {
  // Not its own three: the mast stays put and the target grows upward, as on
  // the ground. So a green is at the same height whichever signal it is on.
  assert.deepEqual(lamps(art.vl).map((l) => ROWS[l.cy]), [3, 4, 5]);
  const green = (k) => lamps(art[k]).find((l) => l.fill === GREEN).cy;
  assert.equal(green('vl'), green('vl-carre'), 'a green sits at one height');
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
    assert.match(svg, /viewBox="0 0 44 116"/, `${name}: one size for all`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}: needs a namespace`);
    // The label lives on the wrapper, so the drawing must not announce itself.
    assert.match(svg, /aria-hidden="true"/, `${name}: should be decorative`);
    assert.ok(!/xlink:href|<image|url\(http/.test(svg), `${name}: refers to something external`);
  }
});

// ------------------------------------------------------------- the picking ---

test('the panel follows the signal, the lamp follows the aspect', () => {
  assert.equal(signalKey('libre', 'carre'), 'vl-carre');
  assert.equal(signalKey('libre', 'semaphore'), 'vl');
  assert.equal(signalKey('avertissement', 'carre'), 'a-carre');
  assert.equal(signalKey('avertissement', 'semaphore'), 'a');
  assert.equal(signalKey('semaphore', 'carre'), 'carre');
  assert.equal(signalKey('semaphore', 'semaphore'), 'semaphore');
});

test('one signal keeps one panel as its aspect changes', () => {
  // A train running up to a carré sees it turn from green through yellow to
  // red; the target must not change size underneath that.
  const carre = ['libre', 'avertissement', 'semaphore'].map((a) => signalKey(a, 'carre'));
  assert.ok(carre.every((k) => lamps(art[k]).length === 5));
  const sem = ['libre', 'avertissement', 'semaphore'].map((a) => signalKey(a, 'semaphore'));
  assert.ok(sem.every((k) => lamps(art[k]).length === 3));
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
