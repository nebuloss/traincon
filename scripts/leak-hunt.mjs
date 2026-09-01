/**
 * Find what the server does not let go of.
 *
 * Usage:  node --expose-gc scripts/leak-hunt.mjs [rounds] [perRound]
 *
 * The process has reached its heap ceiling on five separate days. Every
 * diagnosis so far has been inference from a single reading, and reading the
 * code has run out: every collection that lives longer than one refresh is
 * bounded and pruned. So measure instead — but measure the right thing.
 *
 * Two traps this is built to avoid:
 *
 *   A bounded cache filling up looks exactly like a leak if you only measure
 *   once. So this runs several rounds and prints each one: a cache converges
 *   towards zero growth, a leak keeps charging the same rent every round.
 *
 *   `heapUsed` includes garbage that has not been collected yet, which is why
 *   40 forced polls against production told us nothing. Every reading here is
 *   taken after two full collections, so what is reported is what survived.
 *
 * It replays one captured feed from disk, so it puts no load on SNCF and the
 * input is identical every iteration — anything that grows is ours.
 */

import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = Number(process.argv[2] ?? 5);
const PER_ROUND = Number(process.argv[3] ?? 40);

if (typeof global.gc !== 'function') {
  console.error('run with --expose-gc');
  process.exit(1);
}

/** Bytes still reachable, after actually collecting. */
function settled() {
  global.gc();
  global.gc();
  return v8.getHeapStatistics().used_heap_size;
}

const mb = (b) => (b / 1e6).toFixed(1);

/**
 * Run `iterate` in rounds, reporting what each round failed to give back.
 *
 * A steady non-zero column is a leak. A column that falls away round by round
 * is a cache reaching its bound, which is the behaviour we want.
 */
async function probe(name, iterate, rounds = ROUNDS, per = PER_ROUND) {
  // LEAK_ONLY=rail runs one probe long enough to cross a cache's budget;
  // proving a bound holds needs far more iterations than spotting a leak.
  const only = process.env['LEAK_ONLY'];
  if (only && !name.includes(only)) return null;
  process.stdout.write(`\n${name}\n`);
  // Warm up first: first-call allocation (lazy compilation, initial cache
  // fill) is not a leak and would otherwise dominate round one.
  for (let i = 0; i < per; i++) await iterate(i);

  let prev = settled();
  const start = prev;
  const deltas = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < per; i++) await iterate(i);
    const now = settled();
    const d = now - prev;
    deltas.push(d);
    console.log(
      `  round ${r + 1}: heap ${mb(now).padStart(6)} MB   kept ${(d / 1024).toFixed(0).padStart(7)} KB` +
        `   ${(d / per).toFixed(0).padStart(7)} B/iteration`,
    );
    prev = now;
  }
  const tail = deltas.slice(-2).reduce((a, b) => a + b, 0) / (2 * per);
  console.log(
    `  → over ${rounds * per} iterations: ${mb(prev - start)} MB kept, ` +
      `settling at ${tail.toFixed(0)} B/iteration`,
  );
  return tail;
}

// ── a captured feed, so nothing here touches the network in a loop ───────────

const fixture = path.join(ROOT, 'data', 'leak-hunt-feed.pb');
if (!existsSync(fixture)) {
  const url =
    process.env['SNCF_FEED_URL'] ??
    'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';
  process.stdout.write('capturing one feed to replay… ');
  const res = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
  if (!res.ok) throw new Error(`capture failed: HTTP ${res.status}`);
  writeFileSync(fixture, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}
process.env['SNCF_FEED_FILE'] = fixture;
process.env['SNCF_FEED_SHIFT'] = 'none';

// Keep the harness away from the real data directory's snapshot file.
const scratch = mkdtempSync(path.join(tmpdir(), 'leakhunt-'));

// ── LEAK_COMPOSITION=1: what the baseline is actually made of ────────────────
//
// Knowing the floor matters as much as knowing the growth. Most of it is
// loaded once and never released, so if the floor is close to the ceiling
// there is nothing left for a peak — which is a different fault from a leak
// and has a different fix.
if (process.env['LEAK_COMPOSITION']) {
  const dataDir = path.join(ROOT, 'data');
  const stage = async (name, load) => {
    const before = settled();
    const held = await load();
    const after = settled();
    console.log(`  ${name.padEnd(22)} ${mb(after - before).padStart(7)} MB`);
    return held;
  };
  console.log('baseline, loaded once and kept for the life of the process:\n');
  const kept = [];
  const { GtfsStatic } = await import(path.join(ROOT, 'dist-server/server/GtfsStatic.js'));
  const { RailGraph } = await import(path.join(ROOT, 'dist-server/server/RailGraph.js'));
  const { SignalIndex } = await import(path.join(ROOT, 'dist-server/server/Signals.js'));
  kept.push(await stage('GTFS static', () => GtfsStatic.load(dataDir)));
  kept.push(await stage('rail graph + vmax', () => RailGraph.load(dataDir)));
  kept.push(await stage('signals', () => SignalIndex.load(dataDir)));
  console.log(`\n  ${'total baseline'.padEnd(22)} ${mb(settled()).padStart(7)} MB`);
  console.log(`  (${kept.length} structures held so none is collected early)`);
  process.exit(0);
}

// ── LEAK_DAY=1: a whole day, compressed ──────────────────────────────────────
//
// Replaying one capture keeps every train's identity forever, and the clock
// barely moves. Production does neither: thousands of distinct numbers pass
// through in a day, and `prune()` only lets go of one two hours after it left
// the feed. So a fixed replay cannot show a leak that is keyed on train
// identity — which is the shape of leak this code has had twice before.
//
// This drives a fake clock a minute per poll, so pruning happens on its real
// schedule, and rotates a fifth of the train numbers every simulated hour, so
// roughly six thousand distinct trains pass through as they would in a day.
if (process.env['LEAK_DAY']) {
  const { default: pkg } = await import('gtfs-realtime-bindings');
  const { transit_realtime: rtb } = pkg;
  const { readFileSync } = await import('node:fs');

  const base = rtb.FeedMessage.decode(new Uint8Array(readFileSync(fixture)));
  const originals = base.entity.map((e) => e.id);

  /** The capture with a fifth of its trains given numbers never seen before. */
  function variant(hour) {
    for (let i = 0; i < base.entity.length; i++) {
      const id = originals[i];
      const m = /^OCE([A-Z]{2})(\d+)F/.exec(id ?? '');
      base.entity[i].id =
        m && i % 5 === hour % 5 ? `OCE${m[1]}${900000 + hour * 1000 + (i % 1000)}F` : id;
    }
    return Buffer.from(rtb.FeedMessage.encode(base).finish());
  }

  // A clock the store can be walked through, so two hours really pass.
  let clock = Date.now();
  const realNow = Date.now;
  Date.now = () => clock;
  process.env['SNCF_FEED_SHIFT'] = 'auto'; // rebases the capture onto the fake now

  const { TrainStore: TS } = await import(path.join(ROOT, 'dist-server/server/TrainStore.js'));
  const day = new TS(path.join(ROOT, 'data'));
  await day.start();
  day.stop();
  day.dataDir = scratch;

  console.log('simulating 24 hours, a minute per poll:\n');
  console.log('  hour   heap    trains  history  lastSeen  paths   points');
  const seen = new Set();
  for (let minute = 0; minute < 24 * 60; minute++) {
    const hour = Math.floor(minute / 60);
    if (minute % 60 === 0) writeFileSync(fixture, variant(hour));
    clock += 60_000;
    await day.refresh();
    for (const t of day.trains) seen.add(t.number);
    if (minute % 120 === 119) {
      const h = settled();
      const r = day.stats().memory.retained;
      console.log(
        `  ${String(hour + 1).padStart(4)}  ${mb(h).padStart(6)} MB  ${String(r.trains).padStart(5)}` +
          `  ${String(r.history).padStart(7)}  ${String(r.lastSeen).padStart(8)}` +
          `  ${String(r.paths).padStart(5)}  ${String(r.pathPoints).padStart(7)}`,
      );
    }
  }
  Date.now = realNow;
  console.log(`\n  ${seen.size} distinct train numbers passed through.`);
  console.log(`  final heap ${mb(settled())} MB`);
  process.exit(0);
}

const { TrainStore } = await import(path.join(ROOT, 'dist-server/server/TrainStore.js'));

console.log('loading static data…');
const store = new TrainStore(path.join(ROOT, 'data'));
await store.start();
store.stop(); // no timer: this harness drives the cycle itself
// Snapshot writes go to the scratch directory, not over the real cache.
store.dataDir = scratch;
console.log(`loaded: ${store.stats().total} trains`);

// ── the probes ───────────────────────────────────────────────────────────────

const results = {};

// The whole poll cycle, which is what runs 1440 times a day.
results['refresh'] = await probe('full refresh cycle', () => store.refresh());

// Routing, which owns the biggest per-entry structures. Random pairs of real
// stations so the path cache is exercised the way a day's legs exercise it.
if (store.rail) {
  const sts = [...store.stations.stations.values()].filter((s) => s.lat && s.lon);
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  results['rail.path'] = await probe('rail routing + path cache', () => {
    const a = sts[Math.floor(rnd() * sts.length)];
    const b = sts[Math.floor(rnd() * sts.length)];
    store.rail.path(a.lat, a.lon, b.lat, b.lon, true);
  });
}

// Serving. A leak per request grows with traffic rather than with time.
results['toDTO'] = await probe('toDTO for every train', () => {
  for (const t of store.trains) store.toDTO(t);
});

console.log('\n─── settled cost per iteration ───');
for (const [k, v] of Object.entries(results).filter(([, v]) => v !== null)) {
  console.log(`  ${k.padEnd(12)} ${v.toFixed(0).padStart(8)} B`);
}
console.log(
  '\nA figure that stays high round after round is the leak. One that decays' +
    '\nis a bounded cache filling, which is fine.',
);
process.exit(0);
