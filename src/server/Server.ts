/**
 * HTTP layer: JSON API over the live store, plus the built client.
 *
 * Deliberately dependency-free — node:http is enough for a handful of routes,
 * and it keeps the install footprint to what the GTFS decoding actually needs.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TrainStore } from './TrainStore.ts';
import { trainFromPath, trainFromQuery } from '../shared/deeplink.ts';
import type { Family, TrainDTO } from '../shared/types.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  // Served with its own type so the browser treats it as a manifest; link
  // preview crawlers likewise skip an image sent as octet-stream.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

/** Shown for any page that is not one train. */
const SITE_TITLE = 'Traincon — suivi SNCF en temps réel';
const SITE_DESC =
  'Position estimée, retards et horaires révisés pour les TGV et TER, à partir des données ouvertes.';

/** Escape for an HTML attribute. Everything substituted below is untrusted. */
function attr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** hh:mm in Paris time, which is what the timetable is quoted in. */
function hhmm(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

  /** The bound port — meaningful after listen(0), which the tests use. */
  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
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
      await this.serveStatic(req, res, p, url.search);
    } catch (e) {
      this.json(res, { error: (e as Error).message }, 500);
    }
  }

  /**
   * Absolute origin of this request, for the Open Graph tags.
   *
   * WhatsApp and the other link-preview crawlers reject a relative og:image,
   * and the deployment host is not known at build time, so it is resolved per
   * request. PUBLIC_URL wins when set; otherwise the proxy headers are used.
   *
   * The Host header is client-controlled and this value lands in an HTML
   * attribute, so it is whitelisted rather than escaped: anything carrying a
   * quote, space or angle bracket fails the test and yields no origin, which
   * simply leaves the preview tags out.
   */
  private origin(req: IncomingMessage): string | null {
    const configured = process.env.PUBLIC_URL?.trim();
    if (configured) return configured.replace(/\/+$/, '');

    const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      .toString()
      .split(',')[0]!
      .trim();
    if (!/^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(host)) return null;

    const proto = (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0]!.trim();
    const scheme = proto === 'https' || proto === 'http' ? proto : 'http';
    return `${scheme}://${host}`;
  }

  /**
   * Title and description for a link to one train.
   *
   * A shared link is worth more when the preview already says which train and
   * how late it is — the reader can often stop there. Falls back to the site
   * card when the number is unknown, so a stale link still previews.
   */
  private preview(urlPath: string, search: string): { title: string; desc: string } {
    const hit = trainFromPath(urlPath) ?? trainFromQuery(search);
    if (!hit) return { title: SITE_TITLE, desc: SITE_DESC };

    const train: TrainDTO | undefined = this.store.find(hit.train)[0];
    if (!train) return { title: SITE_TITLE, desc: SITE_DESC };

    const title = `${train.serviceLabel} ${train.number} · ${train.origin} → ${train.destination}`;

    const parts: string[] = [];
    if (train.cancelled) {
      parts.push('Supprimé');
    } else if (train.delay >= 60) {
      parts.push(`Retard ${Math.round(train.delay / 60)} min`);
    } else {
      parts.push("À l'heure");
    }
    if (train.next) {
      parts.push(`prochain arrêt ${train.next.name} à ${hhmm(train.next.time)}`);
    }
    parts.push(`arrivée ${hhmm(train.calls[train.calls.length - 1]!.time)}`);

    return { title, desc: parts.join(' · ') };
  }

  /**
   * Static files, always revalidated.
   *
   * Shipping no cache headers leaves it to the browser's heuristics, and a
   * phone can then keep serving a stale bundle after a deploy. `no-cache`
   * means revalidate every time, and the ETag makes that a 304 with no body
   * when nothing changed.
   */
  private async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
    search = '',
  ): Promise<void> {
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
      let buf = await readFile(file);
      if (path.extname(file) === '.html') {
        const origin = this.origin(req);
        const card = this.preview(urlPath, search);

        // The page now varies by host *and* by which train it describes, and
        // that description changes as the delay does — so the ETag has to
        // cover all of it or a crawler gets a 304 with yesterday's card.
        const vary = `${origin ?? ''}|${card.title}|${card.desc}`;
        headers.etag = `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}-${
          createHash('sha1').update(vary).digest('base64url').slice(0, 12)
        }"`;
        if (req.headers['if-none-match'] === headers.etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }

        buf = Buffer.from(
          buf
            .toString('utf8')
            .replaceAll('%OG_TITLE%', attr(card.title))
            .replaceAll('%OG_DESC%', attr(card.desc))
            .replaceAll('%OG_URL%', attr((origin ?? '') + urlPath))
            .replaceAll('%ORIGIN%', origin ?? ''),
        );
      }
      res.writeHead(200, { ...headers, 'content-length': String(buf.length) });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  }
}
