// The deduced signal, drawn as a French signal.
//
// The distinction these protect is the one that matters on the ground: a
// sémaphore is a stop you may pass at caution after standing, a carré is an
// absolute stop you may not pass at all. Both are red. Drawn as one coloured
// dot they are the same picture, which is why the artwork shows the carré's
// second red lamp and the sémaphore's lit œilleton instead.
//
// The drawings are files now. The version before them was assembled in code
// and had its lamps 5.5 units apart with a radius of 4.4 — so consecutive
// lenses overlapped by three units and the three positions ran together. The
// geometry checks below exist because of that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { signalKey } = await import(path.join(ROOT, 'src/client/core/SignalArt.ts'));

const ART_DIR = path.join(ROOT, 'src/client/assets/signal');
const ASPECTS = ['libre', 'avertissement', 'semaphore', 'carre'];
const art = Object.fromEntries(
  await Promise.all(
    ASPECTS.map(async (k) => [k, await readFile(path.join(ART_DIR, `${k}.svg`), 'utf8')]),
  ),
);

const RED = '#ef2f2f';
const GREEN = '#22c55e';
const YELLOW = '#f2c009';
const WHITE = '#f4f6fa';

/** The lenses: the solid r=5 circles, which are the lamps themselves. */
const lenses = (svg) =>
  [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="5" fill="(#[0-9a-f]{6})"/g)].map((m) => ({
    cx: Number(m[1]),
    cy: Number(m[2]),
    fill: m[3],
  }));

const litCount = (svg, colour) => lenses(svg).filter((l) => l.fill === colour).length;

// ------------------------------------------------------------ the aspects ---

test('voie libre is one green', () => {
  assert.equal(litCount(art.libre, GREEN), 1);
  assert.equal(litCount(art.libre, RED), 0);
  assert.equal(litCount(art.libre, YELLOW), 0);
});

test('avertissement is one yellow', () => {
  assert.equal(litCount(art.avertissement, YELLOW), 1);
  assert.equal(litCount(art.avertissement, GREEN), 0);
});

test('a sémaphore is one red', () => {
  assert.equal(litCount(art.semaphore, RED), 1);
});

test('a carré is two reds — that is what makes it a carré', () => {
  assert.equal(litCount(art.carre, RED), 2);
});

test('the œilleton is lit on a sémaphore and out on a carré', () => {
  // The small white light on the mast is what says a signal may be passed. It
  // is extinguished when a carré is closed, and on some installations that is
  // the only visible difference between the two.
  assert.ok(art.semaphore.includes(WHITE), 'sémaphore: lit');
  assert.ok(!art.carre.includes(WHITE), 'carré: out');
  // But the carré still has the fitting, dark — not a missing lamp.
  assert.match(art.carre, /<circle cx="23.5" cy="53"/, 'the œilleton is there, unlit');
});

test('only a stop signal carries an œilleton at all', () => {
  // On a green or a yellow it would be asserting a permissiveness that has
  // nothing to do with the aspect being shown.
  assert.ok(!art.libre.includes('cy="53"'));
  assert.ok(!art.avertissement.includes('cy="53"'));
});

// ----------------------------------------------------------- the geometry ---

test('the lenses do not overlap each other', () => {
  // The fault this replaced: lamps spaced closer than their own diameter, so
  // the three positions could not be told apart.
  for (const [name, svg] of Object.entries(art)) {
    const ys = lenses(svg)
      .map((l) => l.cy)
      .sort((a, b) => a - b);
    assert.equal(ys.length, 3, `${name}: a signal head has three positions`);
    for (let i = 0; i < ys.length - 1; i++) {
      const gap = ys[i + 1] - ys[i];
      assert.ok(gap > 10, `${name}: lenses ${gap} apart, closer than their 10-unit diameter`);
    }
  }
});

test('there is visible space between the lenses, not merely no overlap', () => {
  // Touching circles read as one blob at 40 px tall.
  for (const [name, svg] of Object.entries(art)) {
    const ys = lenses(svg).map((l) => l.cy).sort((a, b) => a - b);
    for (let i = 0; i < ys.length - 1; i++) {
      assert.ok(ys[i + 1] - ys[i] - 10 >= 1.5, `${name}: only ${ys[i + 1] - ys[i] - 10} units of gap`);
    }
  }
});

test('every lens sits inside the target', () => {
  // A lamp hanging off the panel would look like a fault in the drawing.
  for (const [name, svg] of Object.entries(art)) {
    const target = /<rect x="3" y="([\d.]+)" width="24" height="([\d.]+)"/.exec(svg);
    assert.ok(target, `${name}: no target panel`);
    const top = Number(target[1]);
    const bottom = top + Number(target[2]);
    for (const l of lenses(svg)) {
      assert.ok(l.cy - 5 >= top, `${name}: a lens above the panel`);
      assert.ok(l.cy + 5 <= bottom, `${name}: a lens below the panel`);
    }
  }
});

test('all four drawings share one geometry', () => {
  // They are swapped in place as the aspect changes; if the mast or the panel
  // moved between them the signal would jump.
  const shape = (svg) =>
    [...svg.matchAll(/<rect [^>]*\/>/g)].join('|') + lenses(svg).map((l) => `${l.cx},${l.cy}`).join('|');
  const shapes = ASPECTS.map((k) => shape(art[k]));
  assert.equal(new Set(shapes).size, 1, 'the fixed parts should be identical');
});

test('it is a signal, not a dot: target, mast and foot', () => {
  for (const [name, svg] of Object.entries(art)) {
    assert.equal([...svg.matchAll(/<rect /g)].length, 3, `${name}: foot, mast and cible`);
    assert.match(svg, /viewBox="0 0 30 80"/, `${name}: taller than wide, like the real thing`);
  }
});

test('the drawings are self-contained and decorative', async () => {
  const files = (await readdir(ART_DIR)).filter((f) => f.endsWith('.svg'));
  assert.equal(files.length, ASPECTS.length, `drawings: ${files.join(', ')}`);
  for (const [name, svg] of Object.entries(art)) {
    assert.equal([...svg.matchAll(/<svg[\s>]/g)].length, 1, `${name}: one root`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${name}: needs a namespace`);
    // The label lives on the wrapper, so the drawing must not announce itself.
    assert.match(svg, /aria-hidden="true"/, `${name}: should be decorative`);
    assert.ok(!/xlink:href|<image|url\(http/.test(svg), `${name}: refers to something external`);
  }
});

// ------------------------------------------------------------- the picking ---

test('each aspect picks its own drawing', () => {
  assert.equal(signalKey('libre'), 'libre');
  assert.equal(signalKey('avertissement'), 'avertissement');
  assert.equal(signalKey('semaphore', 'semaphore'), 'semaphore');
  assert.equal(signalKey('semaphore', 'carre'), 'carre');
});

test('a stop of unknown kind is drawn as the commoner one', () => {
  // A sémaphore is far commoner on plain line, and its drawing is the one
  // that does not assert an absolute stop.
  assert.equal(signalKey('semaphore'), 'semaphore');
});

test('an unknown aspect draws nothing', () => {
  // An unlit head would be a claim that the signal is dark, which is a real
  // and serious aspect of its own.
  assert.equal(signalKey('inconnu'), null);
});
