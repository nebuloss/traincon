// The day's worst-delays board, and the reasons attached to it.
//
// Two things here are easy to get wrong and invisible when they are: the board
// must remember a train's *peak* delay rather than its current one (a train
// that made up an hour still had that hour), and it must forget everything
// when the Paris day rolls over rather than carrying yesterday's disasters
// into this morning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DailyBoard } = await import(path.join(ROOT, 'dist-server/server/DailyBoard.js'));
const { Disruptions } = await import(path.join(ROOT, 'dist-server/server/Disruptions.js'));

/**
 * A train in the shape the board reads.
 *
 * Deliberately not a TrainDTO: the board takes the raw train plus a lookup for
 * the service label, so it never pays to build a DTO — and never routes a
 * train over the rail graph — for the whole network once a minute.
 */
const NOW = Math.floor(Date.UTC(2026, 7, 29, 12, 0) / 1000);

const train = (number, worstDelay, extra = {}) => ({
  number,
  service: 'OUIGO',
  origin: 'Hendaye',
  destination: 'Paris Montparnasse',
  worstDelay,
  cancelled: false,
  // Ran this morning and arrived, unless a test says otherwise.
  calls: [{ time: NOW - 7200 }, { time: NOW - 3600 }],
  ...extra,
});

/** Stand-in for serviceMeta. */
const META = () => ({ label: 'TGV INOUI', family: 'tgv' });

const NONE = { live: () => false, reason: () => null };

async function board() {
  const dir = await mkdtemp(path.join(tmpdir(), 'traincon-'));
  const b = new DailyBoard(dir);
  await b.load();
  return { b, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the board records the peak delay, not the current one', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('8540', 90 * 60)], META);
    // The train makes up an hour; it was still 90 minutes down today.
    b.observe([train('8540', 30 * 60)], META);
    assert.equal(b.top(5, NONE)[0].delay, 90 * 60);
  } finally {
    await cleanup();
  }
});

test('trains below the threshold never reach the board', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('1', 5 * 60), train('2', 11 * 60)], META);
    assert.deepEqual(b.top(5, NONE).map((t) => t.number), ['2']);
  } finally {
    await cleanup();
  }
});

test('a cancelled train belongs there whatever its delay says', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('9', 0, { cancelled: true })], META);
    const [row] = b.top(5, NONE);
    assert.equal(row.number, '9');
    assert.equal(row.cancelled, true);
  } finally {
    await cleanup();
  }
});

test('ranking is worst first', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('a', 20 * 60), train('b', 200 * 60), train('c', 60 * 60)], META);
    assert.deepEqual(b.top(5, NONE).map((t) => t.number), ['b', 'c', 'a']);
    assert.equal(b.top(2, NONE).length, 2, 'limit is honoured');
  } finally {
    await cleanup();
  }
});

test('live and reason are filled from the caller', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('8540', 90 * 60)], META);
    const [row] = b.top(5, {
      live: (n) => n === '8540',
      reason: (n) => (n === '8540' ? 'Obstacle sur la voie' : null),
    });
    assert.equal(row.live, true);
    assert.equal(row.reason, 'Obstacle sur la voie');
  } finally {
    await cleanup();
  }
});

test('the board survives a restart within the same day', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'traincon-'));
  try {
    const first = new DailyBoard(dir);
    await first.load();
    first.observe([train('8540', 90 * 60)], META);
    await first.save();

    // A restart mid-afternoon must not lose the morning.
    const second = new DailyBoard(dir);
    await second.load();
    assert.equal(second.top(5, NONE)[0].delay, 90 * 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("yesterday's board is not shown as today's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'traincon-'));
  try {
    const first = new DailyBoard(dir);
    await first.load();
    first.observe([train('8540', 90 * 60)], META);
    await first.save();

    // Rewrite the stored day as the past, as an overnight restart would find it.
    const file = path.join(dir, 'daily-board.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.day = '2020-01-01';
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(saved));

    const second = new DailyBoard(dir);
    await second.load();
    assert.equal(second.top(5, NONE).length, 0, 'a new day starts empty');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the day is ISO, whatever ICU data the host shipped', () => {
  // Alpine's Node falls back to en-US, which gave "8/28/2026" in production
  // while dev produced the ISO form.
  assert.match(DailyBoard.today(new Date('2026-08-28T09:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('the Paris day is what defines "today"', () => {
  // 22:30 UTC on the 27th is already the 28th in Paris, and the timetable's
  // day is the local one.
  assert.equal(DailyBoard.today(new Date('2026-08-27T22:30:00Z')), '2026-08-28');
  assert.equal(DailyBoard.today(new Date('2026-08-28T09:00:00Z')), '2026-08-28');
});

// ── reasons ──────────────────────────────────────────────────────────────────

/** One Navitia page, in the shape the real API returns. */
const page = (items) => ({
  json: async () => ({ disruptions: items }),
  ok: true,
  status: 200,
});

const disruption = (number, text, effect = 'SIGNIFICANT_DELAYS') => ({
  severity: { effect },
  messages: [{ text }],
  impacted_objects: [{ pt_object: { trip: { name: number } } }],
});

test('without a key the index stays empty and nothing breaks', async () => {
  const d = new Disruptions(null);
  assert.equal(d.enabled, false);
  await d.refresh();
  assert.equal(d.get('8540'), null);
  assert.equal(d.size, 0);
});

test('disruptions are indexed by train number', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? page([disruption('8540', 'Obstacle sur la voie')])
      : page([]); // second page empty, ends the sweep
  };
  try {
    const d = new Disruptions('key');
    await d.refresh();
    assert.equal(d.get('8540').reason, 'Obstacle sur la voie');
    assert.equal(d.get('8540').effect, 'SIGNIFICANT_DELAYS');
    assert.equal(d.get('9999'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('a per-stop cause is used when there is no headline message', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? page([
          {
            severity: { effect: 'SIGNIFICANT_DELAYS' },
            messages: [],
            impacted_objects: [
              {
                pt_object: { trip: { name: '123' } },
                impacted_stops: [{ cause: 'Défaillance de matériel' }],
              },
            ],
          },
        ])
      : page([]);
  };
  try {
    const d = new Disruptions('key');
    await d.refresh();
    assert.equal(d.get('123').reason, 'Défaillance de matériel');
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed sweep keeps the previous answers', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return page([disruption('8540', 'Obstacle sur la voie')]);
    if (calls === 2) return page([]);
    throw new Error('network down');
  };
  try {
    const d = new Disruptions('key');
    await d.refresh();
    await d.refresh(); // this one fails partway

    // A stale reason beats none, and the ranking must not depend on this call.
    assert.equal(d.get('8540').reason, 'Obstacle sur la voie');
    assert.match(d.error, /network down/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a refused key is reported, not thrown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const d = new Disruptions('bad');
    await d.refresh(); // must not reject
    assert.match(d.error, /401/);
    assert.equal(d.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});


test('the board costs nothing for a train that does not make it', async () => {
  // This is the whole point of taking a callback: building a DTO per train —
  // which routes each one over the rail graph — once a minute for the entire
  // network is what exhausted the heap and took the service down.
  const { b, cleanup } = await board();
  try {
    let looked = 0;
    const counting = () => {
      looked++;
      return { label: 'TGV INOUI', family: 'tgv' };
    };

    const network = [];
    for (let i = 0; i < 2000; i++) network.push(train(String(i), 0));
    network.push(train('late', 90 * 60));

    b.observe(network, counting);
    assert.equal(looked, 1, 'only the delayed train should be looked up');
    assert.equal(b.size, 1);

    // And a second pass with nothing new must look nothing up at all.
    looked = 0;
    b.observe(network, counting);
    assert.equal(looked, 0, 'an unchanged peak should not be rebuilt');
  } finally {
    await cleanup();
  }
});


// ── rows with nothing behind them ────────────────────────────────────────────

/**
 * The board keeps trains that have finished their run or have not reached the
 * forecast window, so most of it is history rather than live trains. Opening
 * one of those produced a modal that appeared and closed itself the moment the
 * lookup came back empty.
 *
 * Checked in the source: rendering a row means pulling in the DOM and the
 * translation layer, and what matters here is structural.
 */
test('only a live train gets a clickable row in the hall of shame', async () => {
  const view = await readFile(path.join(ROOT, 'src/client/views/WorstView.ts'), 'utf8');
  assert.match(view, /clickable:\s*r\.live/, 'the row must follow the live flag');
});

test('an inert row is not a button and cannot be opened', async () => {
  const row = await readFile(path.join(ROOT, 'src/client/components/TrainRow.ts'), 'utf8');

  // data-open must appear only on the clickable branch.
  const clickableBranch = row.slice(row.indexOf('const open = clickable'));
  const branch = clickableBranch.slice(0, clickableBranch.indexOf(';'));
  assert.match(branch, /data-open/, 'the clickable branch opens the modal');
  assert.ok(
    !branch.slice(branch.indexOf(':')).includes('data-open'),
    'the inert branch must not carry data-open',
  );
  assert.match(branch, /<div class="sg is-static">/, 'inert rows are not buttons');
});

test('an inert row offers no click affordance', async () => {
  const css = await readFile(path.join(ROOT, 'src/client/style.css'), 'utf8');
  const rule = css.slice(css.indexOf('.sg-row.is-static {'));
  assert.match(rule.slice(0, rule.indexOf('}')), /cursor:\s*default/);
});


// ── why a row is not live ────────────────────────────────────────────────────

test('a row says whether it has finished or has not started', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe(
      [
        train('done', 90 * 60), // arrived an hour ago
        train('later', 90 * 60, { calls: [{ time: NOW + 3600 }, { time: NOW + 7200 }] }),
        train('now', 90 * 60, { calls: [{ time: NOW - 3600 }, { time: NOW + 3600 }] }),
      ],
      META,
    );

    const rows = b.top(5, { live: (n) => n === 'now', reason: () => null }, NOW);
    const status = Object.fromEntries(rows.map((r) => [r.number, r.status]));

    assert.equal(status.done, 'finished');
    assert.equal(status.later, 'upcoming');
    assert.equal(status.now, 'running', 'in the feed wins over the schedule');
  } finally {
    await cleanup();
  }
});

test('a train mid-run but absent from the feed is not called arrived', async () => {
  // Claiming it had finished would be a guess, and the wrong one.
  const { b, cleanup } = await board();
  try {
    b.observe([train('x', 90 * 60, { calls: [{ time: NOW - 3600 }, { time: NOW + 3600 }] })], META);
    const [row] = b.top(1, { live: () => false, reason: () => null }, NOW);
    assert.equal(row.status, 'gone');
  } finally {
    await cleanup();
  }
});

test('a board saved before the schedule was recorded still renders', async () => {
  // Older files have no startsAt/endsAt; those rows must not claim a state.
  const { b, cleanup } = await board();
  try {
    b.observe([train('x', 90 * 60, { calls: [] })], META);
    const [row] = b.top(1, { live: () => false, reason: () => null }, NOW);
    assert.equal(row.status, 'gone');
  } finally {
    await cleanup();
  }
});


test('an entry written without a schedule picks one up while it can', async () => {
  // Upgrading mid-day leaves entries that cannot say whether their train has
  // finished. They can be repaired only while the train is still in the feed.
  const { b, cleanup } = await board();
  try {
    b.observe([train('x', 90 * 60, { calls: [] })], META);
    assert.equal(b.top(1, NONE, NOW)[0].status, 'gone', 'nothing to go on yet');

    // Same peak, but now we can see its schedule.
    b.observe(
      [train('x', 90 * 60, { calls: [{ time: NOW - 7200 }, { time: NOW - 3600 }] })],
      META,
    );
    assert.equal(b.top(1, NONE, NOW)[0].status, 'finished');
  } finally {
    await cleanup();
  }
});

test('the backfill does not disturb the recorded peak', async () => {
  const { b, cleanup } = await board();
  try {
    b.observe([train('x', 90 * 60, { calls: [] })], META);
    b.observe([train('x', 10 * 60, { calls: [{ time: NOW - 100 }, { time: NOW }] })], META);
    assert.equal(b.top(1, NONE, NOW)[0].delay, 90 * 60, 'the peak must stand');
  } finally {
    await cleanup();
  }
});
