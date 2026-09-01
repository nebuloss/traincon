// How a train is drawn on the map.
//
// Two representations chosen by zoom, and the close-in one claims to be at
// scale — a TGV should look like 200 m of train against the platform beside
// it. That claim is worth checking, as is the floor that stops a distant train
// collapsing to nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PLAN_ZOOM, WIDTH_M, discView, familyColor, familyGlyph, metresPerPixel, trainLengthM } =
  await import(
  path.join(ROOT, 'src/components/TrainIcon.ts')
);

const train = (family, coupledWith = []) => ({ number: '8540', family, coupledWith });

test('a train is as long as its type', () => {
  assert.equal(trainLengthM(train('tgv')), 200);
  assert.equal(trainLengthM(train('ter')), 80);
  assert.ok(trainLengthM(train('ic')) > 150);
});

test('a coupled set is twice the train', () => {
  // Two TGV units run as one 400 m train, and that is what you see beside a
  // platform built for it.
  assert.equal(trainLengthM(train('tgv', ['8582'])), 400);
  assert.equal(trainLengthM(train('ter', ['1234'])), 160);
});

test('the scale is the map library scale, not the tile-scheme one', () => {
  // MapLibre draws with 512-pixel tiles, so its world is 512·2^zoom across
  // and zoom 0 is about 78 km to the pixel — half the 156 543 that gets
  // quoted for the 256-pixel scheme. Using the familiar number here drew
  // every vehicle at half its length, which showed as a gap between each.
  assert.ok(Math.abs(metresPerPixel(0, 0) - 78271.5) < 1, `${metresPerPixel(0, 0)}`);
  assert.ok(Math.abs(metresPerPixel(1, 0) - metresPerPixel(0, 0) / 2) < 1, 'halves per zoom');
  // And it narrows with latitude.
  assert.ok(metresPerPixel(15, 45) < metresPerPixel(15, 0));
});

test('a coach is drawn about the length it really is', () => {
  // The check the factor-of-two bug would have failed: at zoom 17 over France
  // a 26.4 m Corail coach should be a few tens of pixels long, not ten.
  const px = 26.4 / metresPerPixel(17, 47);
  assert.ok(px > 45 && px < 90, `${px.toFixed(0)} px`);
});

test('a TGV at close zoom fills the screen, as it should', () => {
  // Zoom 17 at Bordeaux is 0.42 m to the pixel, so a 200 m set is about 470
  // px — wider than most phones. That is what being zoomed in on a train at
  // street level looks like, and it is the number the old 256-tile constant
  // halved.
  const px = trainLengthM(train('tgv')) / metresPerPixel(17, 44.8);
  assert.ok(px > 400 && px < 550, `${px.toFixed(0)} px`);
});

test('each family has its own glyph at low zoom', () => {
  const seen = new Set(['tgv', 'ic', 'ter', 'other'].map((f) => discView(train(f))));
  assert.equal(seen.size, 4, 'the four families should be distinguishable');
});

test('the plan view takes over at a zoom where it is readable', () => {
  // Below the threshold a to-scale TER would be a few pixels; above it, tens.
  const below = trainLengthM(train('ter')) / metresPerPixel(PLAN_ZOOM - 1, 45);
  const above = trainLengthM(train('ter')) / metresPerPixel(PLAN_ZOOM, 45);
  assert.ok(above > 20, `${above.toFixed(0)} px at the switch`);
  assert.ok(above > below);
});

test('the real vehicle width is used, not an invented one', () => {
  assert.ok(WIDTH_M > 2.5 && WIDTH_M < 3.5, 'a rail vehicle is about 2.9 m across');
});

test('each type is drawn as itself, not as a generic train', () => {
  // A TER and a TGV should differ before you read the number: different
  // glyph, different colour, different length. The shape difference lives in
  // core/TrainBody; this is the rest of it.
  const tgv = train('tgv');
  const ter = train('ter');
  assert.notEqual(familyGlyph(tgv), familyGlyph(ter));
  assert.notEqual(familyColor(tgv), familyColor(ter));
  assert.notEqual(trainLengthM(tgv), trainLengthM(ter));
});

test('an unknown type still gets drawn', () => {
  // The feed is not obliged to use one of the four names we know.
  const odd = { number: '1', family: 'draisine', coupledWith: [] };
  assert.ok(familyGlyph(odd));
  assert.match(familyColor(odd), /^#/);
  assert.ok(trainLengthM(odd) > 0);
  assert.ok(discView(odd).includes(familyGlyph(odd)));
});
