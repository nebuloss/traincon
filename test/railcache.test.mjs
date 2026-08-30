// The rail path cache's memory bound.
//
// This is what exhausted the heap three times. The cache was capped at 2 500
// *paths*, but a path's cost is its vertex count, and those range from a few
// dozen for a suburban hop to thousands for Bordeaux–Paris. The same cap could
// therefore mean 5 MB or 150 MB depending on which trains happened to be
// running that day — and nothing in the code or the tests said so.
//
// The budget is now vertices. These tests drive the cache through the public
// path-finding entry point so they exercise the real eviction, not a copy of
// it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RailGraph } = await import(path.join(ROOT, 'dist-server/server/RailGraph.js'));

/**
 * A graph shaped like a long line of nodes.
 *
 * Every consecutive pair is connected, so asking for a path between two
 * distant nodes yields one with many vertices — which is exactly the case the
 * old cap mispriced.
 */
function lineGraph(nodes) {
  const features = [];
  for (let i = 0; i < nodes - 1; i++) {
    features.push({
      type: 'Feature',
      properties: { mnemo: 'EXPLOITE' },
      geometry: {
        type: 'LineString',
        // A straight line of closely spaced points, so distances stay small
        // and the detour check accepts the route.
        coordinates: [
          [2 + i * 0.001, 48],
          [2 + (i + 1) * 0.001, 48],
        ],
      },
    });
  }
  return RailGraph.fromGeoJson({ type: 'FeatureCollection', features });
}

test('the cache reports what it holds', () => {
  const g = lineGraph(60);
  assert.deepEqual(g.cacheStats, { paths: 0, points: 0 });

  g.path(48, 2.0, 48, 2.01);
  assert.ok(g.cacheStats.paths >= 1, 'a lookup should be cached');
  assert.ok(g.cacheStats.points > 0, 'and its vertices counted');
});

test('the budget is vertices, and it is respected', () => {
  // A budget of a couple of paths' worth, so eviction runs constantly.
  process.env.RAIL_PATH_POINTS = '60';
  try {
    const g = lineGraph(120);
    let cached = 0;
    for (let i = 0; i < 40; i++) {
      if (g.path(48, 2 + i * 0.001, 48, 2 + (i + 20) * 0.001)) cached++;
      assert.ok(
        g.cacheStats.points <= 60 || g.cacheStats.paths <= 1,
        `budget exceeded: ${g.cacheStats.points} vertices in ${g.cacheStats.paths} paths`,
      );
    }
    assert.ok(cached > 10, `the fixture must produce real paths, got ${cached}`);
    assert.ok(g.cacheStats.points > 0, 'and they must be counted');
  } finally {
    delete process.env.RAIL_PATH_POINTS;
  }
});

test('the vertex count stays honest as entries come and go', () => {
  // The count is maintained incrementally, so a bookkeeping slip would let the
  // budget drift upward for ever without any visible error.
  const g = lineGraph(80);
  for (let i = 0; i < 30; i++) g.path(48, 2 + i * 0.001, 48, 2 + (i + 10) * 0.001);
  assert.ok(g.cacheStats.points > 0, 'the fixture must produce real paths');

  // Re-request the same legs: hits must not double-count.
  const before = g.cacheStats;
  for (let i = 0; i < 30; i++) g.path(48, 2 + i * 0.001, 48, 2 + (i + 10) * 0.001);
  assert.deepEqual(g.cacheStats, before, 'a cache hit must not change the totals');
  assert.ok(g.cacheStats.points >= 0);
});

test('a legful of short hops cannot slip past the vertex budget', () => {
  // The failure mode in production: the count cap was never reached because
  // paths were long, so nothing evicted until the heap ran out.
  process.env.RAIL_PATH_POINTS = '200';
  try {
    const g = lineGraph(200);
    let cached = 0;
    for (let i = 0; i < 100; i++) {
      if (g.path(48, 2 + i * 0.001, 48, 2 + (i + 50) * 0.001)) cached++;
    }
    assert.ok(cached > 20, `the fixture must produce real paths, got ${cached}`);
    assert.ok(
      g.cacheStats.points <= 200 || g.cacheStats.paths <= 1,
      `held ${g.cacheStats.points} vertices against a 200 budget`,
    );
    // The old count-based cap would have kept all 100 of these happily.
    assert.ok(g.cacheStats.paths < 100, 'the budget must actually evict');
  } finally {
    delete process.env.RAIL_PATH_POINTS;
  }
});
