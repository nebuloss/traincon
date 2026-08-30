// The deduced signal, drawn as a French signal.
//
// The distinction these assertions protect is the one that matters on the
// ground: a sémaphore is a stop you may pass at caution after standing, a
// carré is an absolute stop you may not pass at all. Both are red. Drawn as a
// single coloured dot they are the same picture, which is why the icon shows
// the carré's second red lamp and the sémaphore's lit œilleton instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { signalIcon } = await import(path.join(ROOT, 'src/client/components/SignalAspect.ts'));

const RED = '#ef2f2f';
const GREEN = '#22c55e';
const YELLOW = '#f2c009';
const WHITE = '#f4f6fa';

/** How many lenses are lit in this colour (each lit lens draws a halo too). */
const litCount = (svg, colour) =>
  [...svg.matchAll(new RegExp(`r="4\\.4" fill="${colour}"`, 'g'))].length;

test('voie libre is one green', () => {
  const svg = signalIcon('libre');
  assert.equal(litCount(svg, GREEN), 1);
  assert.equal(litCount(svg, RED), 0);
  assert.equal(litCount(svg, YELLOW), 0);
});

test('avertissement is one yellow', () => {
  const svg = signalIcon('avertissement');
  assert.equal(litCount(svg, YELLOW), 1);
  assert.equal(litCount(svg, GREEN), 0);
});

test('a sémaphore is one red', () => {
  const svg = signalIcon('semaphore', 'semaphore');
  assert.equal(litCount(svg, RED), 1);
});

test('a carré is two reds — that is what makes it a carré', () => {
  const svg = signalIcon('semaphore', 'carre');
  assert.equal(litCount(svg, RED), 2);
});

test('the œilleton is lit on a sémaphore and out on a carré', () => {
  // The small white light on the mast is what says a signal may be passed.
  // It is extinguished when a carré is closed, and that is the only visible
  // difference between the two on some installations.
  assert.ok(signalIcon('semaphore', 'semaphore').includes(WHITE), 'sémaphore: lit');
  assert.ok(!signalIcon('semaphore', 'carre').includes(WHITE), 'carré: out');
});

test('with the signal kind unknown, no œilleton is invented', () => {
  // Drawing it either way would assert something about permissiveness that
  // the data does not support.
  const svg = signalIcon('semaphore');
  assert.ok(!svg.includes(WHITE), 'no white light');
  assert.equal(litCount(svg, RED), 1, 'still shows a stop');
});

test('an unknown aspect lights nothing', () => {
  const svg = signalIcon('inconnu');
  for (const c of [RED, GREEN, YELLOW]) assert.equal(litCount(svg, c), 0, c);
});

test('the head always has its three lenses, lit or not', () => {
  // A real cible shows its unlit lenses; a signal with one floating lamp on it
  // would not look like one.
  for (const [aspect, kind] of [
    ['libre', undefined],
    ['avertissement', undefined],
    ['semaphore', 'semaphore'],
    ['semaphore', 'carre'],
    ['inconnu', undefined],
  ]) {
    const svg = signalIcon(aspect, kind);
    const lenses = [...svg.matchAll(/r="4\.4"/g)].length;
    assert.equal(lenses, 3, `${aspect}/${kind}`);
  }
});

test('it is a signal, not a dot: target, mast and foot', () => {
  const svg = signalIcon('libre');
  assert.ok(svg.includes('<svg'), 'drawn as vector');
  assert.ok(svg.includes('fill="#14171d"'), 'a black target');
  assert.ok(svg.includes('fill="#5b6472"'), 'on a mast');
  assert.ok(svg.includes('fill="#4a525e"'), 'with a foot');
  assert.match(svg, /viewBox="0 0 26 40"/, 'taller than wide, like the real thing');
});

test('the icon is decorative; the label carries the meaning', () => {
  // It sits inside an element with the aria-label, so the SVG must not
  // announce itself separately.
  assert.match(signalIcon('libre'), /aria-hidden="true"/);
});

test('two signals on one page do not share a clip id', () => {
  // Both the overview and the map foot can be showing one at the same time.
  const a = signalIcon('libre').match(/id="([^"]+)"/)[1];
  const b = signalIcon('libre').match(/id="([^"]+)"/)[1];
  assert.notEqual(a, b);
});

test('the glow stays on the target', () => {
  // Unclipped, the bottom lamp's halo washes down over the mast.
  assert.match(signalIcon('semaphore', 'carre'), /<g clip-path="url\(#sig-cible-\d+\)">/);
});
