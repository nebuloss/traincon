// Wiring the matched route into the map.
//
// The geometry itself is tested in railmatch.test.mjs, which can run because
// it is pure. This is the part that needs a browser, MapLibre and the tile
// source, so it reads the source as the other map tests do — and it pins the
// handful of things that would otherwise fail silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'src/components/MapView.ts'), 'utf8');

test('metres per pixel is asked for zoom first, everywhere', () => {
  // Both arguments are numbers, so swapping them typechecks perfectly and
  // silently yields about 1e-10 metres to the pixel. Written the wrong way
  // round here once already: the matched route collapsed to a stub at the
  // centre of the view, which looks like a matching failure rather than an
  // arithmetic one. There is nothing but this test to catch it.
  const calls = [...src.matchAll(/metresPerPixel\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'expected the framing and the matching calls');
  for (const args of calls) {
    assert.match(args, /^zoom\b/, `metresPerPixel(${args}) has its arguments the wrong way round`);
  }
});

test('the route is put on the side the region drives on, LGVs included', () => {
  // Which of two running lines the route takes is a fact about the railway:
  // France keeps left, Alsace-Moselle keeps right, and a high-speed line keeps
  // left wherever it is. That last clause is carried entirely by the line
  // speed, and leaving it out typechecks perfectly — the argument is optional.
  //
  // It is not optional. The LGV Est runs through Moselle and Bas-Rhin at
  // 320 km/h, so without the speed the whole Baudrecourt to Strasbourg section
  // put the route on the right-hand track while the train, which is placed
  // with the speed, sat on the left. A track apart, for a hundred kilometres.
  const fn = src.slice(src.indexOf('private matchRoute()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(
    body,
    /keepLeft: \(lon, lat\) => keepsLeft\(lon, lat, this\.drawn\?\.position\.limitKmh\)/,
    'the matcher gets the line speed, as the train does',
  );

  // And the train's own snapping still passes it, so the two agree.
  assert.match(
    src,
    /onSurveyedTrack\(here\.lon, here\.lat, here\.bearing, p\.limitKmh\)/,
    'the train is placed with the same rule and the same speed',
  );
});

test('the matched line takes over exactly as the schematic gives up', () => {
  // Two lines for one route: the graph centreline far out, the surveyed track
  // close in. The ramps have to be mirror images or the route either doubles
  // or disappears somewhere in the middle.
  const real = src.slice(src.indexOf("id: 'follow-real'"));
  const realPaint = real.slice(0, real.indexOf('this.map.getLayer('));
  assert.match(
    realPaint,
    /'line-opacity': \['interpolate', \['linear'\], \['zoom'\], 14, 0, 15, 0\.5, 16, 0\.85\]/,
    'the matched line fades in from 14 to 16',
  );

  const schematic = src.slice(src.indexOf("id: 'follow-path'"));
  assert.match(
    schematic.slice(0, 1200),
    /'line-opacity': \['interpolate', \['linear'\], \['zoom'\], 14, 0\.9, 15, 0\.45, 16, 0\.15\]/,
    'and the schematic fades out over the same range',
  );
});

test('matching starts where the fade does', () => {
  // Below it the schematic is fully opaque, the matched line is transparent,
  // and a railway is drawn one stroke wide anyway — there is nothing to be
  // beside, so there is nothing to correct.
  assert.match(src, /const MATCH_MIN_ZOOM = 14;/);
  assert.match(src, /if \(zoom < MATCH_MIN_ZOOM \|\| !this\.track\)/, 'and it is the guard used');
});

test('every path that can move the view asks for a rematch', () => {
  // A followed train never lets the map go idle, and a map the reader has
  // panned by hand has no animation loop. Neither one alone is enough.
  const idle = src.slice(src.indexOf("this.map.on('idle'"));
  const handler = idle.slice(0, idle.indexOf('\n    });'));
  assert.match(handler, /this\.matchRoute\(\)/, 'idle, for a still map');
  assert.ok(
    handler.indexOf('this.matchRoute()') < handler.indexOf('if (this.animating'),
    'and before the guard that returns while the loop is running',
  );

  const settle = src.slice(src.indexOf('private settle(t: TrainDTO)'));
  assert.match(settle.slice(0, settle.indexOf('\n  }\n')), /this\.matchRoute\(\)/, 'and on settle');

  // In the loop it must come after the recentre, or it matches the stretch
  // that was on screen rather than the one about to be.
  const loop = src.slice(src.indexOf('const drawKm = this.reckoner.follow('));
  const centre = loop.indexOf('this.centreOnTrain(at);');
  const match = loop.indexOf('this.matchRoute();');
  assert.ok(centre !== -1 && match !== -1 && centre < match, 'after the view has been moved');
});

test('a new train does not keep the rails of the last one', () => {
  const block = src.slice(src.indexOf('this.pathFor = t.number;'));
  const upToTrack = block.slice(0, block.indexOf('this.track = line'));
  assert.match(upToTrack, /this\.matchedKey = '';/, 'the cache key is dropped');
  assert.match(upToTrack, /getSource\('follow-real'\)\?\.setData\(/, 'and the drawn line with it');
});

test('the whole view is gathered, not the box around the train', () => {
  // nearbyTrack keeps only the run of each line passing within 700 m of the
  // train, which is right for deciding what it is standing on and useless for
  // drawing a route across the screen.
  const fn = src.slice(src.indexOf('private viewportRails()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /querySourceFeatures\('osmrail', \{ sourceLayer: 'tracks' \}\)/);
  assert.doesNotMatch(body, /inBox/, 'no box filter — whole lines');
});
