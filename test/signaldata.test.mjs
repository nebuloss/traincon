// The published signal positions.
//
// This is the one data file kept in the repository, and it holds only what the
// server reads: the stop signals whole, and every other object's track name
// folded into a set per grid cell. That reduction is worth checking, because
// it is silent when it goes wrong — a file that parses but says the wrong
// thing gives worse answers than no file at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GZ = path.join(ROOT, 'data/geo/signals.json.gz');
const data = JSON.parse(gunzipSync(await readFile(GZ)).toString());

test('the signal positions are published with the source', async () => {
  const info = await stat(GZ);
  assert.ok(info.isFile(), 'data/geo/signals.json.gz is missing');
  // It was 1.2 MB before it was reduced to what is actually read.
  assert.ok(info.size < 400_000, `${info.size} bytes — larger than the reduction should allow`);
  assert.ok(info.size > 50_000, `only ${info.size} bytes`);
});

test('it carries the columns the loader expects', () => {
  assert.equal(data.format, 2, 'the loader keys off this');
  for (const key of ['lat', 'lon', 'carre', 'line']) {
    assert.ok(Array.isArray(data[key]), key);
    assert.equal(data[key].length, data.count, `${key} should have one entry per signal`);
  }
  assert.ok(Array.isArray(data.lines), 'lines');
  assert.ok(Array.isArray(data.tracks), 'tracks');
});

test('it holds both kinds of stop signal, and nothing else', () => {
  // CARRE is the absolute stop, S the sémaphore that may be passed at caution.
  // Everything else in the tile export was dropped: nothing reads it.
  const kinds = new Set(data.carre);
  assert.deepEqual([...kinds].sort(), [0, 1], 'both carrés and sémaphores');
  const carres = data.carre.filter((c) => c === 1).length;
  assert.ok(carres > 10_000, `only ${carres} carrés`);
  assert.ok(data.count > 20_000 && data.count < 40_000, `${data.count} signals`);
});

test('coordinates are whole numbers at the scale the format declares', () => {
  // Degrees times 1e5. Stored as floats they would be a third larger and no
  // more accurate: measured against the unreduced data, this moves the
  // distance to the next signal by at most a metre.
  for (const v of [...data.lat.slice(0, 500), ...data.lon.slice(0, 500)]) {
    assert.ok(Number.isInteger(v), `${v} is not an integer`);
  }
  // France, give or take.
  const lat = data.lat.map((v) => v / 1e5);
  assert.ok(Math.min(...lat) > 41 && Math.max(...lat) < 52, 'latitudes look French');
});

test('line codes are stored once and referenced', () => {
  // A few thousand signals share each code; spelling it out every time was a
  // large part of what made the old file big.
  assert.ok(data.lines.length < data.count / 10, 'the table should be far smaller than the column');
  for (const ix of data.line.slice(0, 2000)) {
    assert.ok(ix === -1 || data.lines[ix] !== undefined, `dangling index ${ix}`);
  }
});

test('the track sets say what grid they were folded at', () => {
  // They are collapsed per cell when the file is made, so a reader using a
  // different cell size would bucket them wrongly. The loader refuses the file
  // rather than answering with the wrong number of tracks.
  assert.equal(data.cell, 0.05, 'must match CELL in server/Signals.ts');
  const server = path.join(ROOT, 'src/server/Signals.ts');
  const src = readFileSync(server, 'utf8');
  assert.match(src, /const CELL = 0\.05;/, 'the server should still use that cell size');
  assert.ok(data.tracks.length > 1000, `only ${data.tracks.length} cells`);
  const [key, names] = data.tracks[0];
  assert.match(key, /^-?\d+,-?\d+$/, 'a cell key');
  assert.ok(Array.isArray(names) && names.length > 0, 'with track names');
});

test('it says where it came from, which the licence requires', () => {
  // Derived from OpenStreetMap by way of carto.tchoo.net, so it is a derived
  // database under ODbL and has to carry its attribution.
  assert.match(String(data.source), /tchoo\.net/, 'the file should name its source');
  assert.match(String(data.attribution), /OpenStreetMap/, 'and its attribution');
  assert.match(String(data.attribution), /ODbL/, 'and its licence');
});

// -------------------------------------------------------------- provisioning ---

test('an install fetches the published file rather than rebuilding it', async () => {
  const sh = await readFile(path.join(ROOT, 'scripts/fetch-geo.sh'), 'utf8');
  assert.match(sh, /signals\.json\.gz/, 'it should fetch the published file');
  assert.ok(!/fetch-signals|pack-signals/.test(sh), 'and not run a tool over the tiles');
});

test('the data ships as a release asset, so a deploy has one place to look', async () => {
  const wf = await readFile(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(wf, /data\/geo\/signals\.json\.gz/, 'attach it to the release');
});

test('signals are refreshed on upgrade, not only on a first install', async () => {
  // The geometry step returns early when the rail network is already present.
  // Signals used to sit behind that, so an upgrade kept whatever was there —
  // and for a long time that was nothing, because nothing fetched them at all.
  const sh = await readFile(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(sh, /fetch_signals\(\)/, 'a step of its own');
  const call = sh.slice(sh.lastIndexOf('fetch_signals'));
  assert.ok(call.length > 0, 'and it is called');
  const fn = sh.slice(sh.indexOf('fetch_signals() {'), sh.indexOf('fix_permissions'));
  assert.ok(!/rfn\.geojson/.test(fn), 'it must not be gated on the rail geometry');
});

test('neither the scraper nor the packer is in the repository', async () => {
  // Both were written to be run once. Publishing them beside the data they
  // produced would only invite pointless load on carto.tchoo.net.
  const tools = await readdir(path.join(ROOT, 'tools'));
  for (const gone of ['fetch-signals', 'pack-signals']) {
    assert.ok(!tools.some((f) => f.includes(gone)), `${gone} is still there`);
  }
});

test('nothing in the source still points at them', async () => {
  const dir = path.join(ROOT, 'src/server');
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue;
    const src = await readFile(path.join(dir, name), 'utf8');
    assert.ok(!/fetch-signals/.test(src), `${name} refers to a tool that is gone`);
  }
});
