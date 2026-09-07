// The route has to be laid onto the rails once the rails arrive.
//
// The surveyed track comes from vector tiles, which load asynchronously. The
// route is matched onto whatever those tiles hold, so the first attempt after
// a map opens routinely has nothing to work with — querySourceFeatures returns
// an empty array while the tiles are still in flight.
//
// That is what the idle handler is for. MapLibre fires idle when the camera
// has stopped and the tiles under it have loaded, and the handler's own
// comment says so: "idle means the tiles are in, which is the whole condition
// for being able to match the route at all".
//
// It could not do its job. matchRoute recorded the view as matched before
// finding out whether there was anything to match against, so the empty first
// attempt marked that view done and every later call at the same view returned
// at the guard. A still map never changes view — a stopped train is held dead
// centre — so the blue matched line was never drawn at all, and what remained
// was the schematic centreline, which is the thing that visibly does not
// follow the track under it.
//
// The stand-in below is the guard sequence and nothing else, so it can be run
// both ways round; the assertions at the bottom pin the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { surveyed as surveyedSrc, view } from './source.mjs';

/**
 * The guard, as a thing that can be run.
 *
 * `commitBeforeWork` picks which order the two happen in: recording the view
 * as matched before the rails are fetched, which is what shipped, or after,
 * which is the fix.
 */
function matcher({ commitBeforeWork }) {
  let matchedKey = '';
  let matchedAt = -Infinity;
  let drawn = null;

  return {
    get drawn() {
      return drawn;
    },
    /** One call at a given view, with whatever the tiles currently hold. */
    match(key, rails, now) {
      if (key === matchedKey || now - matchedAt < 500) return;
      matchedAt = now;
      if (commitBeforeWork) matchedKey = key;

      if (rails.length === 0) {
        // What shipped: an empty answer still went through as a result.
        if (commitBeforeWork) drawn = [];
        return;
      }
      matchedKey = key;
      drawn = rails.map((r) => `matched:${r}`);
    },
  };
}

const VIEW = '8540@-0.5800,44.8300/16.0';

test('the shipped order never recovers once the tiles arrive', () => {
  // Kept as the thing that was actually wrong, so the fix below is measured
  // against it rather than against nothing.
  const m = matcher({ commitBeforeWork: true });

  // The map opens and the first frame runs before any tile has landed.
  m.match(VIEW, [], 0);
  assert.deepEqual(m.drawn, [], 'nothing to draw yet, which is correct so far');

  // The tiles land and the map goes idle, at the same view — a stopped train
  // is held in the centre, so the view is identical.
  m.match(VIEW, ['track-a'], 900);
  assert.deepEqual(m.drawn, [], 'and it stays empty for ever: this is the bug');
});

test('the route is matched once there is track to match it onto', () => {
  const m = matcher({ commitBeforeWork: false });

  m.match(VIEW, [], 0);
  assert.equal(m.drawn, null, 'nothing recorded from an empty attempt');

  m.match(VIEW, ['track-a'], 900);
  assert.deepEqual(m.drawn, ['matched:track-a'], 'idle lays it onto the rails');
});

test('a view that did match is still not matched twice', () => {
  // The guard has to keep doing its job: matching is the most expensive thing
  // this view does, and it runs from the animation loop.
  const m = matcher({ commitBeforeWork: false });

  m.match(VIEW, ['track-a'], 0);
  assert.deepEqual(m.drawn, ['matched:track-a']);

  m.match(VIEW, ['track-b'], 900);
  assert.deepEqual(m.drawn, ['matched:track-a'], 'the same view is not redone');
});

test('the real matchRoute fetches the rails before recording the view', () => {
  const fn = view.slice(view.indexOf('private matchRoute()'), view.indexOf('private onSurveyedTrack('));
  const rails = fn.indexOf('this.surveyed.inView(this.map)');
  const commit = fn.indexOf('this.matchedKey = key;');
  assert.ok(rails !== -1 && commit !== -1, 'both steps should still be there');
  assert.ok(rails < commit, 'the rails must be in hand before the view is called done');
  assert.match(
    fn.slice(rails, commit),
    /if \(rails\.length === 0\) return;/,
    'and an empty answer must leave the view to be tried again',
  );
});

test('an empty gather is not cached like an answer', () => {
  // Whether the tiles have loaded is exactly what the cache must not sit on:
  // caching the empty answer for its full life delays the matched route by
  // that long after the tiles arrive, for no saving — the walk found nothing.
  const fn = surveyedSrc.slice(surveyedSrc.indexOf('inView(map'));
  assert.match(
    fn.slice(0, fn.indexOf('\n  }\n')),
    /this\.viewAt = this\.view\.length \? now : 0;/,
    'the clock starts on an answer worth keeping, not on an empty one',
  );
  // Measured on what is returned rather than on what the walk collected: a
  // walk that throws part way leaves the one non-empty and the other not.
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n  }\n')), /this\.viewAt = now;/);
});
