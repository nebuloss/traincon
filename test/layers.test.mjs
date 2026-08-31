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

/**
 * The output values of a zoom interpolation, e.g. the widths out of
 * `['interpolate', ['linear'], ['zoom'], 15.5, 3, 19, 13]` — the stops
 * alternate zoom, value, and it is the values that are wanted.
 */
function stops(block, prop) {
  const line = new RegExp(`'${prop}':[^\\n]*`).exec(block);
  if (!line) return [];
  const after = line[0].slice(line[0].indexOf("['zoom']") + 8);
  const nums = [...after.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
  return nums.filter((_, i) => i % 2 === 1);
}

const tieBlock = src.slice(src.indexOf("id: 'osm-track-ties'"), src.indexOf('for (const side of'));
const railBlock = src.slice(src.indexOf('for (const side of'));

test('the sleepers are drawn wider than the rails that sit on them', () => {
  // A sleeper is 2.6 m of timber under a 1.435 m gauge: its ends stand proud
  // of the rails, and that overhang is what makes it read as a sleeper rather
  // than as a smudge on the ballast.
  const ties = Math.max(...stops(tieBlock, 'line-width'));
  const rails = Math.max(...stops(railBlock, 'line-width'));
  assert.ok(ties > 0 && rails > 0, `parsed ties ${ties}, rails ${rails}`);
  assert.ok(ties > rails * 3, `ties ${ties} against rails ${rails}`);
});

test('the sleepers are chunky enough to see', () => {
  // Drawn at true size they are 26 cm of timber every 60 cm, which is under a
  // pixel even at z19. Fewer are drawn, each given room to read.
  const dash = /'line-dasharray': \[([\d.]+), ([\d.]+)\]/.exec(tieBlock);
  assert.ok(dash, 'the ties are a dashed line');
  assert.ok(Number(dash[1]) >= 0.4, `a dash of ${dash[1]} line-widths is a hairline`);
});

test('the rails sit inside the sleeper, not off the end of it', () => {
  // The offset is half the gauge; past half the sleeper width the rails would
  // float beside the track instead of resting on it.
  const offsets = [...railBlock.matchAll(/([\d.]+) \* side/g)].map((m) => Number(m[1]));
  assert.ok(offsets.length > 0, 'the rails are offset either side of the centreline');
  const halfSleeper = Math.max(...stops(tieBlock, 'line-width')) / 2;
  assert.ok(Math.max(...offsets) < halfSleeper, `offset ${Math.max(...offsets)} against ${halfSleeper}`);
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

test('the camera aims at where the train is drawn, not where it was reported', () => {
  // These are different places. The reported point is projected onto the
  // drawn route, and between refreshes the train is advanced along it by dead
  // reckoning — two and a half kilometres of it at line speed with thirty
  // seconds between updates. Centring on the reported point walked the map
  // off the train every time it refreshed.
  const centres = [...src.matchAll(/center: ([^\n]*)/g)].map((m) => m[1].trim());
  assert.ok(centres.length >= 2, 'expected the map to centre somewhere');
  let checked = 0;
  for (const c of centres) {
    // The map's own opening view is a fixed pair of numbers — the middle of
    // France, before there is any train to look at.
    if (/^\[[\d.-]+, [\d.-]+\],?$/.test(c)) continue;
    checked++;
    // Either the drawn position itself, or something derived from it — the
    // camera leads a fast train, so the centre is `at` advanced along its
    // heading. What it must never be is the position the server reported.
    const ok = c.includes('drawnPoint()') || c.startsWith('at,') || c.includes('leadPoint(at');
    assert.ok(!/\bp\.lon\b/.test(c) || c.includes('drawnPoint()'), `centres on the reported position: ${c}`);
    assert.ok(ok, `centres on ${c} without asking where the train is drawn`);
  }
  assert.ok(checked >= 2, 'expected at least the framing and the follow paths');
});

test('the train is put on the rails that are drawn under it', () => {
  // The train is placed along SNCF Réseau's geometry; the track beneath it is
  // OpenStreetMap's. They mostly agree, but the SNCF vertices are sparse in
  // places and a long chord cuts the corner of a curve — which is a train
  // drawn beside its own rails. See core/TrackSnap.
  assert.match(src, /snapToTrack\(/, 'the drawn position is snapped');
  assert.match(src, /querySourceFeatures\('osmrail', \{ sourceLayer: 'tracks' \}\)/, 'to the drawn track');
  // Every vehicle, not just the marker: a long train round a curve needs each
  // one placed, and the marker is hidden at the zoom the vehicles appear at.
  const body = src.slice(src.indexOf('const cars = trainCars('), src.indexOf('src.setData(cars)'));
  assert.match(body, /snapToTrack\(/, 'the plan view too');
  assert.match(body, /f\.properties\.bearing = /, 'and turned to match the track it landed on');
});

test('snapping is bounded, so it can run in the animation loop', () => {
  // A view at this zoom holds a few thousand track segments; snapping every
  // vehicle against all of them twelve times a second would be most of a
  // million distance tests per second. The candidates are cut to a box around
  // the train when the cache is built.
  const fn = src.slice(src.indexOf('private nearbyTrack('), src.indexOf('private onSurveyedTrack('));
  assert.match(fn, /railSegsAt/, 'cached over time');
  assert.match(fn, /Math\.abs\(lon - this\.railSegsNear\[0\]\)/, 'and rebuilt when the train moves on');
  assert.match(fn, /Math\.abs\(a\[0\] - lon\) < dLon/, 'filtered to a box around the train');
  // And gathered once per frame rather than once per vehicle.
  const body = src.slice(src.indexOf('const cars = trainCars('), src.indexOf('src.setData(cars)'));
  assert.equal([...body.matchAll(/nearbyTrack\(/g)].length, 1, 'one gather for the whole train');
});


test('the map is held on the train continuously, not once it reaches the side', () => {
  // Waiting for the train to drift to the edge of a box and then easing after
  // it meant the camera was always arriving where the train had been — and at
  // 300 km/h it never caught up. Holding the centre every frame is both the
  // behaviour asked for and less work: no easing, no box, no lead.
  const loop = src.slice(src.indexOf('const step = ()'), src.indexOf('private modelledKm'));
  assert.match(loop, /this\.centreOnTrain\(at\)/, 'centred from the animation loop');
  assert.match(src, /this\.map\.setCenter\(at\)/, 'set outright, not eased');
  // The machinery the old approach needed should be gone, not left lying about.
  assert.ok(!/outsideMiddle|leadPoint|EASE_MS/.test(src), 'the box and the lead are obsolete');
});

test('a following map still lets go while a finger is on it', () => {
  // Taking the map back from under a gesture is the one thing a following map
  // must not do. The gesture ends and the next frame picks the train up again.
  const fn = src.slice(src.indexOf('private centreOnTrain('), src.indexOf('private nearbyTrack('));
  assert.match(fn, /this\.map\.isMoving\(\)/, 'stands down while the map is being moved');
  assert.match(fn, /if \(!this\.following/, 'and only follows when asked to');
  assert.match(src, /this\.map\.on\('moveend'/, 'and takes it back once the gesture settles');
});

test('the refresh does not drag the map away from where the loop holds it', () => {
  // Both easing the centre on every server update and setting it every frame
  // would have the two pulling against each other.
  const follow = src.slice(src.indexOf('} else if (follow) {'), src.indexOf('this.drawMarker(t)'));
  assert.match(follow, /if \(this\.animating\)/, 'the loop owns the centre while it runs');
  assert.match(follow, /easeTo\(\{ zoom: want/, 'leaving only the zoom to the refresh');
});

test('reduced motion slows the train down, it does not stop it', () => {
  // A train's whereabouts is the content of this view, not decoration on it.
  // Refusing to advance it left a reader with that setting watching the train
  // jump once a refresh and sit still in between, at every speed.
  const start = src.slice(src.indexOf('private startDeadReckoning('), src.indexOf('const step = ()'));
  const bail = /if \(![^)]*\|\| this\.stopKm\.length < 2\) \{/.exec(start);
  assert.ok(bail, 'the guard should still be there');
  assert.ok(!/reduced/.test(bail[0]), 'but not stopping on reduced motion');
  assert.match(src, /prefers-reduced-motion/, 'the setting is still honoured');
  assert.match(src, /this\.reduced \? 500 : 80/, 'at a calmer cadence');
});

test('the work done per frame is bounded, because phones run this too', () => {
  // The expensive thing here is walking the tile features to find track to
  // snap to. It is cached, cut to a box around the train, and not done at all
  // until the rails are drawn thickly enough for the correction to show.
  const fn = src.slice(src.indexOf('private onSurveyedTrack('), src.indexOf('private stopAnimation('));
  assert.match(fn, /if \(zoom < 14\) return \[lon, lat\]/, 'skipped until it would be visible');
  const gather = src.slice(src.indexOf('private nearbyTrack('), src.indexOf('private onSurveyedTrack('));
  assert.match(gather, /now - this\.railSegsAt < 4000/, 'and cached between gathers');
});

test('the cheap work runs every frame and the expensive work does not', () => {
  // The map pans with the train now, and a pan stepped twelve times a second
  // judders. So reading the model, moving the marker and holding the centre
  // run at the display's rate, while rebuilding the vehicles — which re-tiles
  // the source in a worker — stays throttled. Doing all of it at 12 Hz was
  // right when only a marker moved on a still map; it is not any more.
  const loop = src.slice(src.indexOf('const step = ()'), src.indexOf('private modelledKm'));
  const move = loop.indexOf('this.centreOnTrain(at)');
  const body = loop.indexOf('this.drawBody(t, drawKm)');
  assert.ok(move >= 0 && body >= 0, 'both should be in the loop');
  assert.ok(move < body, 'the centre is held before the geometry is rebuilt');
  assert.match(loop, /frameAt - lastBody >= BODY_MS/, 'the geometry is throttled');
  assert.match(src, /const MOVE_MS = this\.reduced \? 500 : 0/, 'the movement is not');
});

test('nothing is looked up in the DOM on every frame', () => {
  // Both of these used to be queried twelve times a second for an element
  // that never changes.
  const loop = src.slice(src.indexOf('const step = ()'), src.indexOf('private modelledKm'));
  assert.ok(!/getElementById/.test(loop), 'the panel is resolved once');
  assert.ok(!/querySelector/.test(loop), 'and so is the direction pointer');
  const setup = src.slice(src.indexOf('const BODY_MS'), src.indexOf('const step = ()'));
  assert.match(setup, /const panel = document\.getElementById/, 'hoisted out of the loop');
  assert.match(setup, /const dir = this\.marker\?\.getElement/);
});

test('style and layout are only touched when something moved', () => {
  // Writing the same transform, or re-setting a layout property, costs a
  // recalculation for no change on screen.
  const loop = src.slice(src.indexOf('const step = ()'), src.indexOf('private modelledKm'));
  assert.match(loop, /Math\.abs\(here\.bearing - lastBearing\) > 0\.5/, 'the pointer only turns when the train does');
  const body = src.slice(src.indexOf('private drawBody('), src.indexOf('private stopAnimation('));
  assert.match(body, /this\.iconScale === null \|\| Math\.abs\(scale - this\.iconScale\)/, 'the icon scale only when the zoom moves');
});
