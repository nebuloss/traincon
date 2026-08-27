// Minimal HTTP server: JSON API over the live feed + static frontend.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);

const store = new Store(path.join(ROOT, '..', 'data'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

/**
 * Static files, always revalidated.
 *
 * Shipping no cache headers at all leaves it to the browser's heuristics, and
 * a phone can then keep serving a stale app.js after a deploy — precisely the
 * "still up to date when I come back" case. `no-cache` means revalidate every
 * time, and the ETag makes that a 304 with no body when nothing changed.
 */
async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const st = await stat(file);
    const etag = `W/"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    const headers = {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
      'last-modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const buf = await readFile(file);
    res.writeHead(200, { ...headers, 'content-length': buf.length });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = url.searchParams;

  try {
    if (p === '/api/stats') return json(res, store.stats());

    // Lets the page ask for an immediate retry instead of waiting out the
    // 60 s poll when the user can see the feed is back.
    if (p === '/api/refresh') {
      try { await store.refresh(); }
      catch (e) { return json(res, { ...store.stats(), retried: true, error: String(e.message ?? e) }); }
      return json(res, { ...store.stats(), retried: true });
    }

    // The in-service network, thinned for display and gzipped once at boot.
    if (p === '/api/rail.geojson') {
      const buf = store.railDisplayGz;
      if (!buf) return json(res, { error: 'géométrie indisponible' }, 503);
      res.writeHead(200, {
        'content-type': 'application/geo+json; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=86400',
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    if (p === '/api/trains') {
      const list = store.list({
        family: q.get('family') || undefined,
        minDelay: Number(q.get('minDelay') ?? 0),
        running: q.get('running') === '1',
        q: q.get('q') || '',
      });
      // Map view only needs a light payload.
      if (q.get('light') === '1') {
        return json(res, {
          feedTs: store.feedTs,
          trains: list.map((t) => ({
            number: t.number, service: t.serviceLabel, family: t.family,
            origin: t.origin, destination: t.destination,
            delay: t.maxDelay, cancelled: t.cancelled, trend: t.trend,
            coupledWith: t.coupledWith,
            lat: t.position.lat, lon: t.position.lon,
            bearing: t.position.bearing, basis: t.position.basis,
            speedKmh: t.position.speedKmh,
            geometry: t.position.geometry, quality: t.position.quality,
            observation: t.position.observation,
            legKm: t.position.legKm, fromStop: t.position.fromStop,
            next: t.next ? { name: t.next.name, time: t.next.time, delay: t.next.delay } : null,
          })),
        });
      }
      return json(res, { feedTs: store.feedTs, trains: list });
    }

    let m = p.match(/^\/api\/train\/([\w-]+)\/path$/);
    if (m) {
      const hits = store.find(m[1]);
      if (!hits.length) return json(res, { error: 'train absent du flux' }, 404);
      return json(res, store.journeyGeo(hits[0]));
    }

    m = p.match(/^\/api\/train\/([\w-]+)$/);
    if (m) {
      const hits = store.find(m[1]);
      if (!hits.length) {
        const meta = [...store.statics.trains.values()].find((t) => t.number === m[1]);
        return json(res, {
          found: false, number: m[1],
          knownSchedule: meta ?? null,
          message: meta
            ? 'Not in the live feed right now — it runs outside the ~8 h forecast window, or not today.'
            : 'Unknown train number.',
        }, 404);
      }
      return json(res, { found: true, feedTs: store.feedTs, trains: hits });
    }

    if (p === '/api/suggest') {
      return json(res, store.suggest(q.get('q'), {
        family: q.get('family') || undefined,
        limit: Number(q.get('limit') ?? 20),
      }));
    }

    if (p === '/api/stations') return json(res, store.stations(q.get('q'), Number(q.get('limit') ?? 12)));

    m = p.match(/^\/api\/board\/(.+)$/);
    if (m) {
      const b = store.board(decodeURIComponent(m[1]), { limit: Number(q.get('limit') ?? 30) });
      if (!b) return json(res, { error: 'unknown station' }, 404);
      return json(res, { stop: b.station, feedTs: store.feedTs, departures: b.departures });
    }

    if (p.startsWith('/api/')) return json(res, { error: 'not found' }, 404);
    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, { error: String(e?.message ?? e) }, 500);
  }
});

console.log('Loading SNCF static GTFS…');
await store.start();
const s = store.stats();
console.log(s.total
  ? `Prêt : ${s.total} trains${s.stale ? ' (instantané archivé)' : ` (flux à ${s.ageSec}s)`}, ${store.statics.stops.size} gares.`
  : `Prêt : flux temps réel indisponible, ${store.statics.stops.size} gares chargées. Nouvel essai toutes les 60 s.`);
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
