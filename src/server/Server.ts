/**
 * HTTP layer: JSON API over the live store, plus the built client.
 *
 * Deliberately dependency-free — node:http is enough for a handful of routes,
 * and it keeps the install footprint to what the GTFS decoding actually needs.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TrainStore } from './TrainStore.ts';
import type { Family } from '../shared/types.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

export class ApiServer {
  private readonly server: HttpServer;
  /** Exact-path routes; anything else falls through to the patterns below. */
  private readonly routes = new Map<string, Route>();

  constructor(
    private readonly store: TrainStore,
    private readonly publicDir: string,
  ) {
    this.registerRoutes();
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private json(res: ServerResponse, body: unknown, status = 200): void {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }

  private family(url: URL): Family | undefined {
    const f = url.searchParams.get('family');
    return f && ['tgv', 'ic', 'ter', 'other'].includes(f) ? (f as Family) : undefined;
  }

  // ── routes ─────────────────────────────────────────────────────────────────

  private registerRoutes(): void {
    this.routes.set('/api/stats', (_req, res) => this.json(res, this.store.stats()));

    // Lets the page ask for an immediate retry instead of waiting out the
    // 60 s poll when the user can see the feed is back.
    this.routes.set('/api/refresh', async (_req, res) => {
      try {
        await this.store.refresh();
      } catch (e) {
        return this.json(res, { ...this.store.stats(), retried: true, error: (e as Error).message });
      }
      this.json(res, { ...this.store.stats(), retried: true });
    });

    // The in-service network, thinned for display and gzipped once at boot.
    this.routes.set('/api/rail.geojson', (_req, res) => {
      const buf = this.store.railDisplayGz;
      if (!buf) return this.json(res, { error: 'geometry unavailable' }, 503);
      res.writeHead(200, {
        'content-type': 'application/geo+json; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=86400',
        'content-length': buf.length,
      });
      res.end(buf);
    });

    this.routes.set('/api/trains', (_req, res, url) => {
      const list = this.store.list({
        family: this.family(url),
        minDelay: Number(url.searchParams.get('minDelay') ?? 0),
        running: url.searchParams.get('running') === '1',
        q: url.searchParams.get('q') ?? '',
      });
      // The map only needs a light payload.
      if (url.searchParams.get('light') === '1') {
        return this.json(res, {
          feedTs: this.store.feedTs,
          trains: list.map((t) => ({
            number: t.number,
            service: t.serviceLabel,
            family: t.family,
            origin: t.origin,
            destination: t.destination,
            delay: t.delay,
            cancelled: t.cancelled,
            trend: t.trend,
            coupledWith: t.coupledWith,
            lat: t.position.lat,
            lon: t.position.lon,
            bearing: t.position.bearing,
            basis: t.position.basis,
            speedKmh: t.position.speedKmh,
            geometry: t.position.geometry,
            quality: t.position.quality,
            observation: t.position.observation,
            legKm: t.position.legKm,
            fromStop: t.position.fromStop,
            next: t.next ? { name: t.next.name, time: t.next.time, delay: t.next.delay } : null,
          })),
        });
      }
      this.json(res, { feedTs: this.store.feedTs, trains: list });
    });

    this.routes.set('/api/suggest', (_req, res, url) => {
      this.json(
        res,
        this.store.suggest(url.searchParams.get('q') ?? '', {
          family: this.family(url),
          limit: Number(url.searchParams.get('limit') ?? 20),
        }),
      );
    });

    this.routes.set('/api/stations', (_req, res, url) => {
      this.json(
        res,
        this.store.searchStations(
          url.searchParams.get('q') ?? '',
          Number(url.searchParams.get('limit') ?? 12),
        ),
      );
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;

    try {
      const exact = this.routes.get(p);
      if (exact) return await exact(req, res, url);

      let m = /^\/api\/train\/([\w-]+)\/path$/.exec(p);
      if (m) {
        const hits = this.store.find(m[1]!);
        if (!hits.length) return this.json(res, { error: 'train not in the feed' }, 404);
        return this.json(res, this.store.journeyGeo(hits[0]!));
      }

      m = /^\/api\/train\/([\w-]+)$/.exec(p);
      if (m) {
        const number = m[1]!;
        const hits = this.store.find(number);
        if (!hits.length) {
          const known = this.store.knownSchedule(number);
          return this.json(
            res,
            {
              found: false,
              number,
              knownSchedule: known,
              message: known
                ? 'Not in the live feed right now — it runs outside the ~8 h forecast window, or not today.'
                : 'Unknown train number.',
            },
            404,
          );
        }
        return this.json(res, { found: true, feedTs: this.store.feedTs, trains: hits });
      }

      m = /^\/api\/board\/(.+)$/.exec(p);
      if (m) {
        const station = this.store.stations.findStation(decodeURIComponent(m[1]!));
        if (!station) return this.json(res, { error: 'unknown station' }, 404);
        return this.json(res, { stop: station, feedTs: this.store.feedTs });
      }

      if (p.startsWith('/api/')) return this.json(res, { error: 'not found' }, 404);
      await this.serveStatic(req, res, p);
    } catch (e) {
      this.json(res, { error: (e as Error).message }, 500);
    }
  }

  /**
   * Static files, always revalidated.
   *
   * Shipping no cache headers leaves it to the browser's heuristics, and a
   * phone can then keep serving a stale bundle after a deploy. `no-cache`
   * means revalidate every time, and the ETag makes that a 304 with no body
   * when nothing changed.
   */
  private async serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    let file = path.join(this.publicDir, rel);
    if (!file.startsWith(this.publicDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const st = await stat(file).catch(() => null);
      // Unknown path with no extension: hand back the shell so client routing
      // keeps working on a reload.
      if (!st?.isFile()) {
        if (path.extname(rel)) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        file = path.join(this.publicDir, 'index.html');
      }
      const info = await stat(file);
      const etag = `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
      const headers: Record<string, string> = {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        etag,
        'last-modified': info.mtime.toUTCString(),
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      const buf = await readFile(file);
      res.writeHead(200, { ...headers, 'content-length': String(buf.length) });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  }
}
