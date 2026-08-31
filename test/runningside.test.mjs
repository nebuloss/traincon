// Which side of a double-track line trains keep to.
//
// France runs on the left, unlike the roads. Alsace-Moselle is the exception:
// its lines were built between 1871 and 1918 when the territory was German,
// and they kept right-hand running when it came back. The junctions carry
// flyovers — sauts-de-mouton — so trains change sides without crossing.
//
// The exception belongs to the line and not the place: the LGVs run left
// throughout, including the LGV Est where it crosses the region.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { FAST_KMH, inAlsaceMoselle, keepsLeft } = await import(
  path.join(ROOT, 'src/client/core/RunningSide.ts')
);

/** Somewhere on a classic line, at a classic line speed. */
const side = (lon, lat, kmh = 160) => (keepsLeft(lon, lat, kmh) ? 'left' : 'right');

test('the rest of France keeps left', () => {
  for (const [name, lon, lat] of [
    ['Paris', 2.32, 48.86],
    ['Lyon', 4.84, 45.76],
    ['Bordeaux', -0.556, 44.826],
    ['Marseille', 5.38, 43.3],
    ['Lille', 3.06, 50.63],
  ]) {
    assert.equal(side(lon, lat), 'left', name);
  }
});

test('Alsace-Moselle keeps right', () => {
  // All three departments of the territory annexed in 1871.
  for (const [name, lon, lat] of [
    ['Strasbourg', 7.7347, 48.5839],
    ['Colmar', 7.355, 48.079],
    ['Mulhouse', 7.34, 47.75],
    ['Metz', 6.1757, 49.11],
    ['Thionville', 6.167, 49.358],
    ['Sarrebourg', 7.055, 48.735],
  ]) {
    assert.equal(side(lon, lat), 'right', name);
  }
});

test('Metz is inside it, which a hand-guessed bounding box got wrong', () => {
  // The capital of Moselle sits at 6.176 E, west of where a plausible-looking
  // box put the region's edge. The box is computed from the outlines now.
  assert.ok(inAlsaceMoselle(6.1757, 49.11), 'Metz');
  assert.equal(side(6.1757, 49.11), 'right');
});

test('the neighbours keep left, close as they are', () => {
  // Meurthe-et-Moselle, the Vosges and the Meuse were never annexed, and the
  // boundary between them and Moselle is the boundary between the two rules.
  for (const [name, lon, lat] of [
    ['Nancy', 6.1744, 48.69],
    ['Épinal', 6.45, 48.17],
    ['Verdun', 5.383, 49.16],
  ]) {
    assert.equal(side(lon, lat), 'left', name);
  }
});

test('Belfort keeps left, because it was never annexed', () => {
  // Detached from Haut-Rhin in 1871 precisely because it held out, which is
  // why it is a department of its own. Including it would be the easy mistake.
  assert.ok(!inAlsaceMoselle(6.8639, 47.638), 'Territoire de Belfort');
  assert.equal(side(6.8639, 47.638), 'left');
});

test('a high-speed line keeps left wherever it runs', () => {
  // The LGV Est crosses Alsace-Moselle and runs on the left throughout; the
  // flyovers at its connections are there for exactly that reason.
  assert.equal(side(7.7347, 48.5839, 320), 'left', 'LGV through Strasbourg');
  assert.equal(side(6.1757, 49.11, 300), 'left', 'LGV past Metz');
  // And the same ground at a classic line speed is right-hand.
  assert.equal(side(7.7347, 48.5839, 160), 'right');
});

test('the high-speed threshold is the one the router uses', () => {
  // The server calls a line high-speed at 250 and keeps ordinary trains off
  // it; the same number decides the running side, so the two agree.
  assert.equal(FAST_KMH, 250);
  assert.equal(side(7.7347, 48.5839, FAST_KMH), 'left', 'at the threshold');
  assert.equal(side(7.7347, 48.5839, FAST_KMH - 1), 'right', 'just below it');
});

test('an unknown line speed is treated as a classic line', () => {
  // Which is the safer default: it is what most track is, and the alternative
  // would put every train in the region on the wrong side.
  assert.equal(side(7.7347, 48.5839, null), 'right');
  assert.equal(side(7.7347, 48.5839, undefined), 'right');
  assert.equal(side(2.32, 48.86, null), 'left', 'and changes nothing elsewhere');
});

test('somewhere far away is rejected without walking the outline', () => {
  // The cheap box first: this is asked on every frame a train is snapped.
  assert.ok(!inAlsaceMoselle(-0.556, 44.826), 'Bordeaux');
  assert.ok(!inAlsaceMoselle(2.32, 48.86), 'Paris');
  assert.ok(!inAlsaceMoselle(0, 0), 'the Atlantic');
});

test('the boundary is a boundary, not a smear', () => {
  // Walking east from Nancy into Moselle, the answer changes once and stays
  // changed — a ragged outline would flip back and forth.
  const answers = [];
  for (let lon = 6.0; lon <= 7.0; lon += 0.05) answers.push(side(lon, 49.0));
  const flips = answers.filter((a, i) => i && a !== answers[i - 1]).length;
  assert.ok(flips <= 2, `${flips} changes of side across the border: ${answers.join(' ')}`);
});
