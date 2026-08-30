// The published signal positions.
//
// This is the one data file kept in the repository. It exists so an install
// downloads it rather than rebuilding it from somebody else's tile server —
// the network changes slowly, the file does not, and a tile scraper left in a
// public repo invites being run again and again for data already sitting
// here. These check that the arrangement holds: the file is present and
// readable, the fetch script reaches for it, and the scraper has not come
// back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GZ = path.join(ROOT, 'data/geo/signals.json.gz');

test('the signal positions are published with the source', async () => {
  const info = await stat(GZ);
  assert.ok(info.isFile(), 'data/geo/signals.json.gz is missing');
  // Small enough to sit in a repository, large enough to be the real thing.
  assert.ok(info.size > 500_000, `only ${info.size} bytes`);
  assert.ok(info.size < 5_000_000, `${info.size} bytes is too big to commit`);
});

test('it unpacks to the shape the server reads', async () => {
  const data = JSON.parse(gunzipSync(await readFile(GZ)).toString());
  assert.equal(typeof data.count, 'number');
  assert.ok(Array.isArray(data.rows), 'rows');
  assert.equal(data.rows.length, data.count, 'the count should match the rows');
  assert.ok(data.count > 100_000, `only ${data.count} signals`);
  for (const key of ['lat', 'lon', 'type']) {
    assert.ok(key in data.rows[0], `a row needs ${key}`);
  }
});

test('it carries the two kinds the spacing model turns on', async () => {
  // CARRE is the absolute stop, S the sémaphore that may be passed at caution.
  // Everything else in the file is context; these two do the work.
  const data = JSON.parse(gunzipSync(await readFile(GZ)).toString());
  const kinds = new Set(data.rows.map((r) => r.type));
  assert.ok(kinds.has('CARRE'), 'no carrés');
  assert.ok(kinds.has('S'), 'no sémaphores');
});

test('it says where it came from, which the licence requires', async () => {
  // Derived from OpenStreetMap by way of carto.tchoo.net, so it is a derived
  // database under ODbL and has to carry its attribution.
  const data = JSON.parse(gunzipSync(await readFile(GZ)).toString());
  assert.match(String(data.source), /tchoo\.net/, 'the file should name its source');
  const readme = await readFile(path.join(ROOT, 'data/geo/README.md'), 'utf8');
  assert.match(readme, /OpenStreetMap/, 'attribution');
  assert.match(readme, /ODbL/, 'licence');
});

test('the fetch script downloads it rather than rebuilding it', async () => {
  const sh = await readFile(path.join(ROOT, 'scripts/fetch-geo.sh'), 'utf8');
  assert.match(sh, /signals\.json\.gz/, 'it should fetch the published file');
  assert.ok(!/fetch-signals/.test(sh), 'and not run a scraper');
});

test('the tile scraper is not in the repository', async () => {
  // It was written to be run once. Publishing it alongside the data it
  // produced would only invite pointless load on carto.tchoo.net.
  const tools = await readdir(path.join(ROOT, 'tools'));
  assert.ok(!tools.some((f) => /fetch-signals/.test(f)), `still there: ${tools.join(', ')}`);
});

test('nothing in the source still points at it', async () => {
  const dir = path.join(ROOT, 'src/server');
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue;
    const src = await readFile(path.join(dir, name), 'utf8');
    assert.ok(!src.includes('fetch-signals'), `${name} refers to a tool that is gone`);
  }
});
