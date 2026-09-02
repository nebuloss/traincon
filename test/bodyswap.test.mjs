// Swapping the disc for the train drawn on the ground.
//
// A train has two representations and exactly one of them should ever be on:
// a DOM marker far out, and a row of symbols laid along the rails close in.
// They are drawn by different machinery, and that is the whole difficulty.
// Setting the class hides the disc in the same frame; the symbol layer needs
// its data tiled and its artwork registered before it can draw anything. Ask
// only whether the zoom is high enough and there is a moment with neither on
// screen — the train simply vanishes.
//
// Reported as draw bugs while zooming in and out on a slow train, and a slow
// train is the case that finds it: zoomForSpeed frames a stopped train at 14.5
// and a slow one at up to 15, and PLAN_ZOOM — where the disc gives way to the
// body — is 15. The threshold sits exactly where such a train is framed, so
// zooming around one crosses it over and over.
//
// MapView needs a browser, MapLibre and the bundler's asset handling, so this
// reads the source, as the other map tests do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'src/components/MapView.ts'), 'utf8');
const art = await readFile(path.join(ROOT, 'src/core/TrainArt.ts'), 'utf8');

const showBody = (() => {
  const fn = src.slice(src.indexOf('private showBody()'));
  return fn.slice(0, fn.indexOf('\n  }\n'));
})();

test('the disc goes only when the body can actually replace it', () => {
  // All three, because any one of them missing means the layer draws nothing
  // while the disc is already hidden.
  assert.match(showBody, /this\.bodyDrawn/, 'the source holds vehicles');
  assert.match(showBody, /this\.liveryReady\.has\(this\.drawnLivery\)/, 'the artwork is registered');
  assert.match(showBody, />= PLAN_ZOOM/, 'and the zoom is past the threshold');
});

test('the threshold is the same one the layer carries', () => {
  // If the class and the layer's minzoom ever disagree, a band of zooms shows
  // both representations at once or neither.
  const layer = src.slice(src.indexOf("id: 'train-cars'"));
  assert.match(layer.slice(0, 400), /minzoom: PLAN_ZOOM/, 'the layer uses PLAN_ZOOM');
});

test('the vehicles are ready a zoom before they are shown', () => {
  // Filling the source re-tiles it in a worker. Doing that at the same zoom
  // that reveals the layer is the gap all over again, so the data is kept
  // current from a level below and is tiled and waiting by the time it counts.
  assert.match(src, /const KEEP_BODY_ZOOM = PLAN_ZOOM - 1;/);
  const body = src.slice(src.indexOf('private drawBody('));
  assert.match(
    body.slice(0, body.indexOf('const here =')),
    /this\.map\.getZoom\(\) < KEEP_BODY_ZOOM/,
    'and that is the zoom the source is emptied below',
  );
});

test('everything that changes the answer settles it again', () => {
  // Four things can: a redraw, a redraw that cannot draw, the artwork
  // arriving, and the zoom moving.
  const body = src.slice(src.indexOf('private drawBody('), src.indexOf('private showBody()'));
  assert.equal(
    [...body.matchAll(/this\.showBody\(\)/g)].length,
    3,
    'both exits of drawBody, and the livery promise',
  );
  assert.match(
    body,
    /ensureLivery\([\s\S]*?this\.showBody\(\)/,
    'the promise settles it once the artwork is there',
  );

  const zoom = src.slice(src.indexOf("this.map.on('zoom'"));
  assert.match(zoom.slice(0, zoom.indexOf('});')), /this\.showBody\(\)/, 'and so does a zoom');
});

test('a theme change gets its artwork back', () => {
  // setStyle drops every registered image along with the layers. The set of
  // liveries already asked for is what stops them being asked for twice, so
  // left uncleared it also stopped them being asked for again — the vehicles
  // never got their drawings back, and the disc had already been hidden for
  // them, so the train disappeared for good.
  const fn = src.slice(src.indexOf('restyle(onReady'));
  const restyle = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(restyle, /this\.liveries\.clear\(\)/, 'the liveries asked for');
  assert.match(restyle, /this\.liveryReady\.clear\(\)/, 'and the ones that arrived');
  assert.match(restyle, /this\.bodyDrawn = false/, 'the source went with the style too');
  assert.match(restyle, /this\.iconLat = null/, 'and the size expression with the layer');
});

test('a livery only counts as ready when it actually loaded', () => {
  // ensureLivery resolves false when a drawing fails to rasterise, and a
  // failed livery must not be what the disc stands aside for.
  const body = src.slice(src.indexOf('private drawBody('), src.indexOf('private showBody()'));
  assert.match(body, /if \(ok\) this\.liveryReady\.add\(livery\);/, 'only on success');
  assert.match(body, /else this\.liveries\.delete\(livery\);/, 'and a failure is retried');
  assert.match(art, /Promise<boolean>/, 'which is what ensureLivery reports');
});
