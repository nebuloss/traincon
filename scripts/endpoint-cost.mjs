/**
 * What each endpoint costs the server, in time and in bytes.
 *
 * Usage:  node scripts/endpoint-cost.mjs
 *
 * The question this exists to answer is which work has to happen on the server
 * because only the server has the data, and which is being done there merely
 * because that is where it was written. Anything in the second group is a
 * candidate for the client — and every line moved is a line that does not have
 * to be ported.
 *
 * Cost is measured warm, after the path cache has filled, because that is the
 * state the server actually serves in. A cold first call routes every leg and
 * would flatter nothing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const fixture = path.join(ROOT, 'data', 'leak-hunt-feed.pb');
if (!existsSync(fixture)) {
  const res = await fetch(
    process.env['SNCF_FEED_URL'] ??
      'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates',
    { headers: { 'accept-encoding': 'gzip' } },
  );
  writeFileSync(fixture, Buffer.from(await res.arrayBuffer()));
}
process.env['SNCF_FEED_FILE'] = fixture;
process.env['SNCF_FEED_SHIFT'] = 'none';

const { TrainStore } = await import(path.join(ROOT, 'dist-server/server/TrainStore.js'));
const { ApiServer } = await import(path.join(ROOT, 'dist-server/server/Server.js'));

const store = new TrainStore(path.join(ROOT, 'data'));
await store.start();
store.stop();
const api = new ApiServer(store, path.join(ROOT, 'dist'));
await api.listen(0);
const B = `http://127.0.0.1:${api.port}`;
const num = store.trains[0]?.number ?? '8501';

const ENDPOINTS = [
  ['/api/trains', 'every train, full DTO'],
  ['/api/trains?light=1', 'every train, map payload'],
  ['/api/trains?light=1&running=1', 'map payload, moving only'],
  ['/api/trains?light=1&family=tgv', 'map payload, one family'],
  ['/api/worst', 'the palmarès'],
  ['/api/suggest?q=paris', 'search, one keystroke'],
  ['/api/stats', 'counters'],
  [`/api/train/${num}`, 'one train, full'],
  [`/api/train/${num}/path`, 'one train, route geometry'],
];

const N = 20;
console.log(`${store.trains.length} trains loaded\n`);
console.log('  ms/call   KB   endpoint');
for (const [url, note] of ENDPOINTS) {
  // Warm: fill the path cache and let the JIT settle before timing.
  let bytes = 0;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(B + url);
    bytes = (await r.arrayBuffer()).byteLength;
  }
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await (await fetch(B + url)).arrayBuffer();
  const ms = (performance.now() - t0) / N;
  console.log(
    `  ${ms.toFixed(1).padStart(7)}  ${(bytes / 1024).toFixed(0).padStart(4)}   ${url}  — ${note}`,
  );
}
await api.close();
process.exit(0);
