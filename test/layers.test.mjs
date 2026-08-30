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

/** The layer ids in the order addLayer is called with them. */
const added = [...src.matchAll(/id: '([\w-]+)',\n\s*type: '(?:line|fill|circle|symbol)'/g)].map(
  (m) => m[1],
);

test('the map adds the layers this test thinks it does', () => {
  // A guard on the guard: if the layers are renamed, the assertions below
  // would quietly pass against nothing.
  for (const id of ['follow-path', 'train-body-fill', 'train-body-line', 'osm-tracks']) {
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
    /const underTrain = this\.map\.getLayer\('train-body-fill'\)\s*\?\s*'train-body-fill'\s*:\s*undefined;/,
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
    added.indexOf('osm-tracks') < added.indexOf('train-body-fill'),
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
