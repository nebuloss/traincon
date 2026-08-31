// Holding the map on the train, without falling over.
//
// setCenter fires movestart, move and moveend synchronously, inside the call.
// The moveend handler centres on the train. So centring fired moveend, which
// centred, which fired moveend — until the stack ran out. In the browser that
// surfaced as a RangeError from MapLibre's handler manager and an "already
// running" from its task queue, and the map was dead.
//
// The guard is a re-entrancy flag. This exercises it against a stand-in map
// that fires its events the way MapLibre really does, because the shape of
// the bug is entirely in that synchronous re-entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A map that fires move events synchronously from setCenter, as MapLibre does. */
function fakeMap() {
  const listeners = new Map();
  let centre = { lng: 0, lat: 0 };
  let moving = false;
  return {
    calls: 0,
    on(ev, fn) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    },
    getCenter: () => centre,
    isMoving: () => moving,
    setCenter(c) {
      this.calls++;
      centre = { lng: c[0], lat: c[1] };
      for (const fn of listeners.get('moveend') ?? []) fn();
    },
    fire(ev) {
      for (const fn of listeners.get(ev) ?? []) fn();
    },
    setMoving(v) {
      moving = v;
    },
  };
}

/**
 * The guard as MapView has it. Kept here rather than importing the component,
 * which needs a browser, MapLibre and the bundler's asset handling; the whole
 * of the bug is these few lines.
 */
function centrer(map, { following = true } = {}) {
  let centring = false;
  return function centreOnTrain(at) {
    if (!following || !map) return;
    if (centring) return;
    if (map.isMoving()) return;
    const now = map.getCenter();
    if (Math.abs(now.lng - at[0]) < 1e-7 && Math.abs(now.lat - at[1]) < 1e-7) return;
    centring = true;
    try {
      map.setCenter(at);
    } finally {
      centring = false;
    }
  };
}

test('centring does not call itself through its own move event', () => {
  // The crash, reproduced: without the flag this recurses until the stack
  // gives out.
  const map = fakeMap();
  const centre = centrer(map);
  map.on('moveend', () => centre([1, 47]));

  centre([1, 47]);
  assert.equal(map.calls, 1, `setCenter ran ${map.calls} times for one request`);
});

test('without the guard it really does blow the stack', () => {
  // Proof that the test above is testing something: the same harness with the
  // flag taken out is the bug as it shipped.
  const map = fakeMap();
  let centre;
  const unguarded = (at) => {
    if (map.isMoving()) return;
    map.setCenter(at);
  };
  centre = unguarded;
  map.on('moveend', () => centre([Math.random(), 47]));
  assert.throws(() => centre([1, 47]), RangeError, 'should overflow the stack');
});

test('and it survives being driven every frame', () => {
  const map = fakeMap();
  const centre = centrer(map);
  map.on('moveend', () => centre([map.getCenter().lng, map.getCenter().lat]));

  for (let i = 0; i < 200; i++) centre([1 + i * 1e-4, 47]);
  assert.equal(map.calls, 200, 'one move per frame, no more');
});

test('a map already where it is asked to be is left alone', () => {
  // Every setCenter fires a round of move events whether it moved or not.
  // For a stopped train that is a great deal of traffic for nothing.
  const map = fakeMap();
  const centre = centrer(map);
  centre([1, 47]);
  centre([1, 47]);
  centre([1, 47]);
  assert.equal(map.calls, 1, 'only the first should do anything');
});

test('a gesture keeps hold of the map', () => {
  // Taking the map back from under a finger is the one thing a following map
  // must not do.
  const map = fakeMap();
  const centre = centrer(map);
  map.setMoving(true);
  centre([1, 47]);
  assert.equal(map.calls, 0, 'not while the reader is moving it');
  map.setMoving(false);
  centre([1, 47]);
  assert.equal(map.calls, 1, 'and taken back once they stop');
});

test('nothing happens at all when not following', () => {
  const map = fakeMap();
  const centre = centrer(map, { following: false });
  centre([1, 47]);
  assert.equal(map.calls, 0);
});

test('the component has the same guards', async () => {
  // The stand-in above models the fix; this checks the real one still has it.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = await readFile(path.join(root, 'src/client/components/MapView.ts'), 'utf8');

  const fn = src.slice(src.indexOf('private centreOnTrain('), src.indexOf('private nearbyTrack('));
  assert.match(fn, /if \(this\.centring\) return;/, 're-entrancy guard');
  assert.match(fn, /this\.centring = true;/, 'and it is actually set');
  assert.match(fn, /finally \{\s*this\.centring = false;/, 'and cleared even if setCenter throws');
  assert.match(fn, /getCenter\(\)/, 'and it skips a move that would change nothing');
});
