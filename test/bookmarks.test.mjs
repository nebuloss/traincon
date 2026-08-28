// Bookmarks that point at nothing.
//
// A bookmark is a promise: the user believes those trains are being watched.
// Two ways that quietly breaks — a number that is real but dormant, and a
// number that never existed — need to look different, and above all a bad
// entry must always be removable. It was not: the shape check ran on removal
// too, so anything that got into storage in the wrong shape was stuck there
// for ever, with the star reporting "invalid" and doing nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bookmarks persists through Prefs, which needs localStorage. */
function stubStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  globalThis.window = globalThis.window ?? { addEventListener() {} };
  return map;
}

const store = stubStorage();
const { Bookmarks } = await import(path.join(ROOT, 'src/client/core/Bookmarks.ts'));

function fresh() {
  store.clear();
  return new Bookmarks();
}

test('a valid number can be added and removed', () => {
  const b = fresh();
  assert.equal(b.toggle('8540').added, true);
  assert.equal(b.has('8540'), true);
  assert.equal(b.toggle('8540').added, false);
  assert.equal(b.has('8540'), false);
});

test('junk is refused on the way in', () => {
  const b = fresh();
  assert.equal(b.toggle('<script>'), null);
  assert.equal(b.toggle(''), null);
  assert.equal(b.toggle('12345678'), null, 'too long to be a train number');
  assert.equal(b.count, 0);
});

test('a bad entry already stored can always be removed', () => {
  // However it got in — an older build, hand-edited storage, a sync from
  // another device — it must not be stuck. This used to return null.
  const b = fresh();
  b.numbers.push('NOT-A-NUMBER');
  assert.equal(b.has('NOT-A-NUMBER'), true);

  const r = b.toggle('NOT-A-NUMBER');
  assert.ok(r, 'removal must not be refused by the add-time shape check');
  assert.equal(r.added, false);
  assert.equal(b.has('NOT-A-NUMBER'), false);
});

test('a coupled set is removed as one', () => {
  const b = fresh();
  b.toggle('8540');
  b.toggle('8582');
  const r = b.toggle('8540,8582');
  assert.equal(r.added, false);
  assert.equal(b.count, 0);
});

// ── how the server describes a miss ───────────────────────────────────────────

const { ApiServer } = await import(path.join(ROOT, 'dist-server/server/Server.js'));

test('the server names the two kinds of miss', async () => {
  const store = {
    find: () => [],
    // 8540 is in the timetable but not running; 9999 is nowhere.
    knownSchedule: (n) =>
      n === '8540' ? { number: '8540', service: 'OUI', line: 'Hendaye - Paris' } : null,
  };
  const server = new ApiServer(store, path.join(ROOT, 'dist'));
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;

    const dormant = await (await fetch(`${base}/api/train/8540`)).json();
    assert.equal(dormant.found, false);
    assert.equal(dormant.reason, 'dormant');
    assert.ok(dormant.knownSchedule, 'a dormant train still has a timetable entry');

    const unknown = await (await fetch(`${base}/api/train/9999`)).json();
    assert.equal(unknown.found, false);
    assert.equal(unknown.reason, 'unknown');
    assert.equal(unknown.knownSchedule, null);
  } finally {
    await server.close();
  }
});


// ── telling the two kinds of miss apart ──────────────────────────────────────

const { missingKind } = await import(path.join(ROOT, 'src/shared/missing.ts'));

test('a train in the timetable but not running is dormant', () => {
  assert.equal(
    missingKind({ reason: 'dormant', knownSchedule: { number: '8081', service: 'OUI', line: 'x' } }),
    'dormant',
  );
});

test('a number that is nowhere is unknown', () => {
  assert.equal(missingKind({ reason: 'unknown', knownSchedule: null }), 'unknown');
});

test('an older server without the field is read from its timetable entry', () => {
  // Guessing "unknown" for a real train would invite deleting a good bookmark,
  // so a known schedule wins when the field is absent.
  assert.equal(
    missingKind({ knownSchedule: { number: '8081', service: 'OUI', line: 'x' } }),
    'dormant',
  );
  assert.equal(missingKind({ knownSchedule: null }), 'unknown');
});


// ── a card that does nothing must not look like it does ──────────────────────

test('the missing-bookmark card offers no click affordance', async () => {
  // Twice now the card stopped opening but still advertised that it would:
  // first a data-open that no longer had a modal behind it, then the hand
  // cursor .card sets for every card. Both are checked here.
  const view = await readFile(path.join(ROOT, 'src/client/views/WatchView.ts'), 'utf8');
  const css = await readFile(path.join(ROOT, 'src/client/style.css'), 'utf8');

  const body = view.slice(view.indexOf('private static missingCard'));
  const card = body.slice(0, body.indexOf('\n  }\n'));

  assert.ok(!card.includes("dataset['open']"), 'a missing card must not open the modal');
  assert.ok(!card.includes('role="button"'), 'nor announce itself as a button');
  assert.ok(!card.includes('tabIndex'), 'nor take focus as one');

  // .card sets cursor:pointer for every card, so the missing variant has to
  // turn it back off explicitly.
  const rule = css.slice(css.indexOf('.card.is-missing {'));
  assert.match(rule.slice(0, rule.indexOf('}')), /cursor:\s*default/);
});

test('the actions inside it are still clickable', async () => {
  const css = await readFile(path.join(ROOT, 'src/client/style.css'), 'utf8');
  // Making the card inert must not disarm the star or the remove button.
  for (const sel of ['.star {', '.link-btn {']) {
    const rule = css.slice(css.indexOf(sel));
    assert.match(rule.slice(0, rule.indexOf('}')), /cursor:\s*pointer/, `${sel} needs a pointer`);
  }
});
