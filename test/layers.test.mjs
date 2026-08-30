// The train must be drawn on top of the line it runs on.
//
// This has gone wrong twice. MapLibre stacks layers in the order they are
// added, and the route layers are added lazily on the first train shown —
// long after the train's own layers exist from startup — so appending them
// puts the line over the train. The fix is a `beforeId`, and it is the kind
// of argument that gets dropped in a refactor without anything failing until
// someone looks at the map, so it is checked here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'src/client/components/MapView.ts'), 'utf8');
const css = await readFile(path.join(ROOT, 'src/client/style.css'), 'utf8');

/** The layer ids in the order addLayer is called with them. */
const added = [...src.matchAll(/id: '([\w-]+)',\n\s*type: '(?:line|fill|circle|symbol)'/g)].map(
  (m) => m[1],
);

test('the train is drawn from artwork, one symbol per vehicle', () => {
  // A single icon for the whole train cannot bend, and a train on the curve
  // into a station is exactly where you are looking when you zoom in.
  assert.match(src, /type: 'symbol',\n\s*source: 'train-body'/, 'a symbol layer');
  assert.match(src, /'icon-rotate': \['get', 'bearing'\]/, 'each vehicle turns on its own');
  assert.match(src, /'icon-rotation-alignment': 'map'/, 'they lie on the ground, not on the screen');
  // Symbols hide each other by default to keep labels readable, and a train
  // is a row of symbols touching end to end.
  assert.match(src, /'icon-allow-overlap': true/, 'or every other vehicle vanishes');
  assert.match(src, /'icon-ignore-placement': true/);
});

test('the map adds the layers this test thinks it does', () => {
  // A guard on the guard: if the layers are renamed, the assertions below
  // would quietly pass against nothing.
  for (const id of ['follow-path', 'train-cars', 'osm-track-bed']) {
    assert.ok(added.includes(id), `no layer called ${id} any more`);
  }
});

test('the route layers are inserted under the train, not on top of it', () => {
  // Both of them: the stop circles are drawn from the same source and would
  // otherwise sit over the train at a station, which is exactly where you are
  // looking when you zoom in that far.
  const followBlock = src.slice(src.indexOf("id: 'follow-path'"));
  const upToEnd = followBlock.slice(0, followBlock.indexOf('this.pathFor = t.number'));
  const inserts = [...upToEnd.matchAll(/\n\s*underTrain,/g)];
  assert.equal(inserts.length, 2, 'follow-path and follow-stops both need a beforeId');
});

test('the insertion point is the train body, and it exists by then', () => {
  assert.match(
    src,
    /const underTrain = this\.map\.getLayer\('train-cars'\)\s*\?\s*'train-cars'\s*:\s*undefined;/,
    'the beforeId should name the body layer and tolerate its absence',
  );
  // The body layers are created during init, the route layers on first show,
  // so by the time the beforeId is needed the target is there.
  assert.ok(
    src.indexOf('addTrainBody()') < src.indexOf("id: 'follow-path'"),
    'the body must be set up before a train is shown',
  );
});

test('the train body is drawn above the surveyed tracks', () => {
  assert.ok(
    added.indexOf('osm-track-bed') < added.indexOf('train-cars'),
    'a train hidden under the station track layout would be worse than useless',
  );
});

test('nothing is inserted before a layer that does not exist yet', () => {
  // addLayer throws on an unknown beforeId, and the station-track setup
  // swallows exceptions, so a bad beforeId there would silently drop the
  // whole layout rather than fail loudly.
  const literals = [...src.matchAll(/addLayer\([\s\S]*?\},\s*'([\w-]+)',?\s*\)/g)].map((m) => m[1]);
  for (const target of literals) {
    assert.ok(added.includes(target), `inserted before unknown layer '${target}'`);
  }
});

// The layers this vector source actually serves, read off a real tile at
// Bordeaux Saint-Jean (z12-14) with tools that decode MVT. Checked in rather
// than fetched, so the suite stays offline; refresh it if the server changes.
const OSMRAIL_LAYERS = new Set([
  'bridges',
  'buffer_stops',
  'level_crossings',
  'milestones',
  'platforms',
  'power_lines',
  'radio_lines',
  'routes',
  'security_systems',
  'signals',
  'speeds',
  'stations',
  'tracks',
  'tunnels',
]);

test('track is drawn as track, not as a line', () => {
  // Brown sleepers with two steel rails offset either side of the centreline.
  // A single line in a compromise grey was the version nobody could see.
  assert.ok(added.includes('osm-track-bed'), 'a sleeper bed');
  assert.ok(src.includes("id: 'osm-track-ties'"), 'sleepers across it');
  assert.match(src, /line-offset/, 'rails offset from the centre');
  assert.equal([...src.matchAll(/osm-track-rail-/g)].length, 1, 'both rails from one loop');
  assert.match(src, /for \(const side of \[-1, 1\]/, 'one rail each side');
});

test('every source-layer asked for is one the tiles carry', () => {
  // A wrong name is not an error anywhere: MapLibre renders an empty layer and
  // says nothing. 'platform_edges' was asked for for a while and never existed.
  const asked = [...src.matchAll(/'source-layer': '([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(asked.length > 0, 'no vector layers found to check');
  for (const name of asked) {
    assert.ok(OSMRAIL_LAYERS.has(name), `no layer '${name}' in these tiles`);
  }
});

test('tiles are fetched from the URL that answers, not the one that redirects', () => {
  // The .pbf form replies 301 to the extensionless one, so every tile cost a
  // redirect before it loaded.
  const tiles = [...src.matchAll(/tiles: \['([^']+)'\]/g)].map((m) => m[1]);
  for (const url of tiles) {
    assert.ok(!url.endsWith('.pbf'), `${url} redirects; drop the extension`);
  }
});

test('a style swap puts back everything the first load added', () => {
  // setStyle drops every custom source and layer. Rebuilding only some of them
  // left the map without station tracks or a train body after a theme change,
  // and the symptom was a stale marker rather than an error.
  const init = src.slice(src.indexOf('await new Promise'), src.indexOf('private addStationTracks'));
  const restyle = src.slice(src.indexOf('restyle(onReady'), src.indexOf('private frame('));
  const adders = [...init.matchAll(/this\.(add\w+)\(\)/g)].map((m) => m[1]);
  assert.ok(adders.length >= 3, 'expected several setup calls on load');
  for (const fn of adders) {
    assert.ok(restyle.includes(`this.${fn}()`), `restyle() never calls ${fn}()`);
  }
});

test('the marker is hidden by something MapLibre will not overwrite', () => {
  // MapLibre writes style.opacity straight onto the marker element to fade
  // markers the terrain covers. An inline style beats a class, so hiding the
  // marker by setting opacity on the root silently did nothing.
  const rule = css.match(/\.train-marker\.is-bodied[^{]*\{([^}]*)\}/g) ?? [];
  assert.ok(rule.length > 0, 'no rule hides the marker when the body is drawn');
  const rootOpacity = rule.some((r) => /^\.train-marker\.is-bodied\s*\{/.test(r) && /opacity/.test(r));
  assert.ok(!rootOpacity, 'opacity on the marker root is overwritten by MapLibre');
  assert.ok(rule.some((r) => /display:\s*none/.test(r)), 'hide the children instead');
});

test('every palette token the map asks for is actually defined', () => {
  // Theme.token reads a CSS custom property and returns '' when there is no
  // such property. MapLibre rejects '' as a colour by throwing — and the
  // station-track setup catches everything, so one typo here silently drops
  // the entire layout with no error in the console.
  const asked = new Set([...src.matchAll(/Theme\.token\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(asked.size > 0, 'no tokens found to check');
  const defined = new Set([...css.matchAll(/^\s*--([\w-]+):/gm)].map((m) => m[1]));
  for (const name of asked) {
    assert.ok(defined.has(name), `MapView reads --${name}, which the stylesheet never defines`);
  }
});

test('a token used by the map is defined for the dark theme too', () => {
  // Otherwise it resolves to '' after a theme swap and takes the layer with
  // it, which is worse than a wrong colour: it is no layer at all.
  const asked = [...src.matchAll(/Theme\.token\('([\w-]+)'\)/g)].map((m) => m[1]);
  const dark = css.slice(css.indexOf('[data-theme="dark"]'));
  const inherited = new Set(['ok', 'bad', 'fg', 'panel', 'muted', 'accent', 'dead', 'late', 'verylate', 'rail', 'rail-hs']);
  for (const name of new Set(asked)) {
    if (inherited.has(name)) continue;
    assert.ok(dark.includes(`--${name}:`), `--${name} has no dark-theme value`);
  }
});
