/** Entry point: build the store, wait for the first load, then serve. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrainStore } from './TrainStore.ts';
import { ApiServer } from './Server.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env['PORT'] ?? 3000);
// Vite builds the client to dist/; in development it is served by Vite itself.
const PUBLIC_DIR = process.env['PUBLIC_DIR'] ?? path.join(ROOT, 'dist');

const store = new TrainStore(path.join(ROOT, 'data'));

console.log('Loading SNCF static GTFS…');
await store.start();

const s = store.stats();
console.log(
  s.total
    ? `Ready: ${s.total} trains${s.stale ? ' (archived snapshot)' : ` (feed ${s.ageSec}s old)`}, ${store.stations.stations.size} stations.`
    : `Ready: real-time feed unavailable, ${store.stations.stations.size} stations loaded. Retrying every 60 s.`,
);

const server = new ApiServer(store, PUBLIC_DIR);
await server.listen(PORT);
console.log(`http://localhost:${PORT}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.stop();
    void server.close().then(() => process.exit(0));
  });
}
