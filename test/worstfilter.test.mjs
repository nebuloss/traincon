// Choosing which of the day's worst delays to show.
//
// The palmarès is a record of the whole day, which is the point of it — a
// train that lost an hour this morning belongs on the board even though it
// finished long ago. But by the evening that is most of the board, and a
// reader wanting to know what is late *right now* had to read past a dozen
// trains that arrived hours ago. Hence the filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pickShown } = await import(path.join(ROOT, 'src/client/core/WorstBoard.ts'));

/** A board row, worst first as the server sends them. */
const row = (number, delay, live, status = live ? 'running' : 'finished') => ({
  number,
  delay,
  live,
  status,
});

const board = [
  row('1', 5400, false), // finished this morning, the worst of the day
  row('2', 4800, false),
  row('3', 3600, true), // still out there
  row('4', 3000, false),
  row('5', 2400, true),
];

test('the whole day is the default, in the order the server ranked it', () => {
  const shown = pickShown(board, 'all');
  assert.deepEqual(shown.map((r) => r.number), ['1', '2', '3', '4', '5']);
});

test('the live filter keeps only the trains still running', () => {
  const shown = pickShown(board, 'live');
  assert.deepEqual(shown.map((r) => r.number), ['3', '5']);
});

test('and it keeps them worst-first', () => {
  // The ranking is the server's; filtering must not disturb it, or first
  // place would stop meaning the worst.
  const shown = pickShown(board, 'live');
  for (let i = 1; i < shown.length; i++) {
    assert.ok(shown[i - 1].delay >= shown[i].delay, 'still in order');
  }
});

test('a live board with nothing on it comes back empty, not full', () => {
  // Late at night everything has finished. The view says so rather than
  // falling back to the whole day, which would be answering another question.
  const allDone = board.map((r) => ({ ...r, live: false }));
  assert.equal(pickShown(allDone, 'live').length, 0);
  assert.equal(pickShown(allDone, 'all').length, 5);
});

test('it shows what it is asked for and no more', () => {
  const many = Array.from({ length: 50 }, (_, i) => row(String(i), 6000 - i * 10, true));
  assert.equal(pickShown(many, 'all', 25).length, 25);
  assert.equal(pickShown(many, 'live', 25).length, 25);
  assert.equal(pickShown(many, 'live', 5).length, 5);
});

test('the cut happens after the filter, not before', () => {
  // This is the reason the view asks the endpoint for its maximum rather than
  // for a screenful: the running trains are scattered through a board ranked
  // by delay, so cutting first would leave the live view nearly empty.
  const mostlyFinished = [
    ...Array.from({ length: 30 }, (_, i) => row(`done${i}`, 6000 - i, false)),
    row('running', 1000, true),
  ];
  assert.equal(pickShown(mostlyFinished, 'live', 25).length, 1, 'the one running train survives');
  // Cutting to 25 first would have dropped it, since it ranks 31st by delay.
  assert.equal(pickShown(mostlyFinished.slice(0, 25), 'live', 25).length, 0, 'as it would have');
});

test('being on the board and being openable are the same test', () => {
  // The row uses `live` to decide whether tapping it opens anything. Filtering
  // on the same flag means every row on the live board can be opened, and none
  // of them gives the modal that closes itself.
  for (const r of pickShown(board, 'live')) {
    assert.equal(r.live, true, `${r.number} should be openable`);
  }
});

test('a train that has left the feed is not called running', () => {
  // `status` and `live` can disagree: a train can be scheduled as running and
  // have dropped out of the feed. The flag that decides is the one about the
  // feed, because that is what having a position depends on.
  const ghost = [row('ghost', 3600, false, 'running')];
  assert.equal(pickShown(ghost, 'live').length, 0, 'no position, nothing to watch');
});
