/**
 * The live snapshot: current trains, delay history, coupling, and the queries
 * the API serves from them.
 *
 * Also owns resilience. The upstream proxy goes down regularly, so a failed
 * refresh must never take the server with it, and a restart during an outage
 * should show the last known state rather than an empty network.
 */

import { gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GtfsStatic, serviceMeta } from './GtfsStatic.ts';
import { FeedClient, type RawTrain } from './FeedClient.ts';
import { RailGraph } from './RailGraph.ts';
import { Train } from './Train.ts';
import { CouplingDetector, type CouplingResult } from './CouplingDetector.ts';
import type {
  DelaySample,
  Family,
  JourneyGeo,
  StatsDTO,
  SuggestionDTO,
  TrainDTO,
  Trend,
} from '../shared/types.ts';

const POLL_MS = 60_000;
const HISTORY_MAX = 60;
/** Keep a train's history this long after it leaves the feed. */
const PRUNE_AFTER_MS = 2 * 3600 * 1000;

export interface ListFilter {
  family?: Family | 'all';
  minDelay?: number;
  running?: boolean;
  q?: string;
}

export class TrainStore {
  private statics!: GtfsStatic;
  private rail: RailGraph | null = null;
  private readonly feed: FeedClient;
  private readonly coupling = new CouplingDetector();

  private trains: Train[] = [];
  private byNumber = new Map<string, Train[]>();
  private couples: CouplingResult = {
    partners: new Map(),
    positions: new Map(),
    delays: new Map(),
    calls: new Map(),
  };
  private readonly history = new Map<string, DelaySample[]>();
  /** number -> when it was last in the feed, so stale entries can be dropped. */
  private readonly lastSeen = new Map<string, number>();

  feedTs = 0;
  fetchedAt = 0;
  error: string | null = null;
  replay = false;
  fromSnapshot = false;
  railDisplayGz: Buffer | null = null;

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataDir = 'data') {
    this.feed = new FeedClient();
  }

  get stations(): GtfsStatic {
    return this.statics;
  }

  async start(): Promise<void> {
    this.statics = await GtfsStatic.load(this.dataDir);
    try {
      this.rail = await RailGraph.load(this.dataDir);
      if (this.rail.display) {
        this.railDisplayGz = gzipSync(Buffer.from(JSON.stringify(this.rail.display)), { level: 9 });
        // Only the gzipped buffer is ever served, so drop the parsed object —
        // it is ~15 000 line strings that would otherwise sit in the heap for
        // the life of the process.
        this.rail.display = null;
      }
    } catch (e) {
      console.warn('rail geometry unavailable, falling back to straight lines:', (e as Error).message);
    }

    // A transient feed failure must not stop the server from coming up: serve
    // the last good snapshot if we have one, and let the poller take over.
    try {
      await this.refresh();
    } catch (e) {
      this.error = (e as Error).message;
      console.warn('real-time feed unavailable at boot:', this.error);
      const n = await this.loadSnapshot();
      console.warn(
        n ? `resuming from the last snapshot: ${n} trains` : 'no snapshot available, retrying in 60 s',
      );
    }

    this.timer = setInterval(() => {
      this.refresh().catch((e: Error) => {
        this.error = e.message;
      });
    }, POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.statics.isStale) {
      try {
        this.statics = await GtfsStatic.load(this.dataDir);
      } catch {
        /* keep the old tables */
      }
    }

    const { trains: raw, feedTs, replay } = await this.feed.load(this.statics);
    const now = Math.floor(Date.now() / 1000);

    this.trains = raw.map((r: RawTrain) => new Train(r));
    this.feedTs = feedTs;
    this.fetchedAt = Date.now();
    this.error = null;
    this.replay = replay;
    this.fromSnapshot = false;

    this.byNumber = new Map();
    for (const t of this.trains) {
      const list = this.byNumber.get(t.number);
      if (list) list.push(t);
      else this.byNumber.set(t.number, [t]);

      const cur = t.currentDelay(now);
      const h = this.history.get(t.number) ?? [];
      const last = h[h.length - 1];
      if (!last || last.delay !== cur) {
        h.push({ t: feedTs, delay: cur });
        if (h.length > HISTORY_MAX) h.shift();
        this.history.set(t.number, h);
        this.coupling.noteChange(t.number, feedTs);
      }
    }

    this.couples = this.coupling.detect(this.trains, now, this.rail);
    this.prune();
    void this.saveSnapshot().catch(() => undefined);
  }

  /**
   * Forget trains that have left the feed.
   *
   * The history and coupling maps are keyed by train number and were only ever
   * added to, so a long-running process accumulated every service of every day
   * it had been up. Trains drop out of the feed briefly, so allow a grace
   * period rather than pruning to the current set on every refresh.
   */
  private prune(): void {
    const live = new Set(this.trains.map((t) => t.number));
    const now = Date.now();
    for (const n of live) this.lastSeen.set(n, now);

    for (const [n, at] of this.lastSeen) {
      if (live.has(n) || now - at < PRUNE_AFTER_MS) continue;
      this.lastSeen.delete(n);
      this.history.delete(n);
      this.coupling.forget(n);
    }
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  /** Replay writes to its own file: a dev session must never overwrite the
   * production cache with time-shifted fixture data. */
  private get snapshotFile(): string {
    return path.join(
      this.dataDir,
      process.env['SNCF_FEED_FILE'] ? 'last-feed.replay.json' : 'last-feed.json',
    );
  }

  private async saveSnapshot(): Promise<void> {
    if (!this.trains.length || this.replay) return;
    await writeFile(
      this.snapshotFile,
      JSON.stringify({
        feedTs: this.feedTs,
        savedAt: Date.now(),
        trains: this.trains.map((t) => ({
          id: t.id,
          number: t.number,
          service: t.service,
          line: t.line,
          origin: t.origin,
          destination: t.destination,
          calls: t.calls,
          cancelled: t.cancelled,
          maxDelay: t.worstDelay,
          lastDelay: t.terminus.delay,
          feedTs: t.feedTs,
        })),
      }),
    );
  }

  private async loadSnapshot(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(this.snapshotFile, 'utf8')) as {
        feedTs?: number;
        savedAt?: number;
        trains?: RawTrain[];
      };
      if (!Array.isArray(raw.trains) || !raw.trains.length) return 0;
      this.trains = raw.trains.map((r) => new Train(r));
      this.feedTs = raw.feedTs ?? 0;
      this.fetchedAt = raw.savedAt ?? 0;
      this.fromSnapshot = true;
      this.byNumber = new Map();
      for (const t of this.trains) {
        const list = this.byNumber.get(t.number);
        if (list) list.push(t);
        else this.byNumber.set(t.number, [t]);
      }
      this.couples = this.coupling.detect(this.trains, Math.floor(Date.now() / 1000), this.rail);
      return this.trains.length;
    } catch {
      return 0;
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────

  /** Delay trend over the retained history. */
  private trend(number: string): Trend {
    const h = this.history.get(number);
    if (!h || h.length < 2) return 'stable';
    const d = h[h.length - 1]!.delay - h[0]!.delay;
    if (d >= 120) return 'worsening';
    if (d <= -120) return 'recovering';
    return 'stable';
  }

  /** Turn a Train into the shape the API serves. */
  toDTO(train: Train, now = Math.floor(Date.now() / 1000)): TrainDTO {
    const meta = serviceMeta(train.service);
    const rec = this.couples.delays.get(train.number) ?? null;
    const own = train.currentDelay(now);
    const corrected = this.couples.calls.get(train.number);
    const view = corrected ? train.withCalls(corrected) : train;

    return {
      id: view.id,
      number: view.number,
      service: view.service,
      serviceLabel: meta.label,
      family: meta.family,
      line: view.line,
      origin: view.origin,
      destination: view.destination,
      calls: view.calls,
      cancelled: view.cancelled,
      delay: rec?.delay ?? view.currentDelay(now),
      ownDelay: own,
      worstDelay: train.worstDelay,
      position: this.couples.positions.get(train.number) ?? view.positionAt(now, this.rail),
      next: view.nextCall(now),
      trend: this.trend(train.number),
      history: this.history.get(train.number) ?? [],
      coupledWith: this.couples.partners.get(train.number) ?? [],
      reconciled: rec,
      feedTs: view.feedTs,
    };
  }

  list(filter: ListFilter = {}): TrainDTO[] {
    const now = Math.floor(Date.now() / 1000);
    let out = this.trains.map((t) => this.toDTO(t, now));
    const { family, minDelay = 0, running = false, q = '' } = filter;
    if (family && family !== 'all') out = out.filter((t) => t.family === family);
    if (minDelay) out = out.filter((t) => t.delay >= minDelay);
    if (running) out = out.filter((t) => ['between', 'at_station'].includes(t.position.basis));
    if (q) {
      const s = q.toLowerCase();
      out = out.filter(
        (t) =>
          t.number.includes(s) ||
          t.origin.toLowerCase().includes(s) ||
          t.destination.toLowerCase().includes(s) ||
          t.calls.some((c) => c.name.toLowerCase().includes(s)),
      );
    }
    return out;
  }

  find(number: string): TrainDTO[] {
    const now = Math.floor(Date.now() / 1000);
    return (this.byNumber.get(String(number)) ?? []).map((t) => this.toDTO(t, now));
  }

  knownSchedule(number: string): { number: string; service: string; line: string } | null {
    for (const meta of this.statics.trains.values()) {
      if (meta.number === number) return meta;
    }
    return null;
  }

  /** Stop ids served by any train currently in the feed. */
  private servedStopIds(): Set<string> {
    const served = new Set<string>();
    for (const t of this.trains) for (const c of t.calls) served.add(c.stopId);
    return served;
  }

  searchStations(q: string, limit = 12) {
    const served = this.servedStopIds();
    return this.statics.searchStations(q, served, limit).map((s) => ({
      uic: s.uic,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      live: s.stopIds.some((i) => served.has(i)),
    }));
  }

  /**
   * Autocomplete over live trains: by number, by origin/destination, or by any
   * station served. An exact number match ranks first, then trains that are
   * actually moving.
   */
  suggest(query: string, opts: { family?: Family | 'all'; limit?: number } = {}): SuggestionDTO[] {
    const s = query.trim().toLowerCase();
    if (!s) return [];
    const { family, limit = 20 } = opts;
    const now = Math.floor(Date.now() / 1000);
    const out: SuggestionDTO[] = [];

    for (const t of this.trains) {
      const meta = serviceMeta(t.service);
      if (family && family !== 'all' && meta.family !== family) continue;

      let score = -1;
      let why = '';
      if (t.number === s) [score, why] = [100, 'number'];
      else if (t.number.startsWith(s)) [score, why] = [90, 'number'];
      else if (t.number.includes(s)) [score, why] = [70, 'number'];
      else if (t.destination.toLowerCase().startsWith(s)) [score, why] = [60, 'destination'];
      else if (t.origin.toLowerCase().startsWith(s)) [score, why] = [55, 'origin'];
      else if (t.destination.toLowerCase().includes(s)) [score, why] = [45, 'destination'];
      else if (t.origin.toLowerCase().includes(s)) [score, why] = [40, 'origin'];
      else {
        const stop = t.calls.find((c) => c.name.toLowerCase().includes(s));
        if (stop) [score, why] = [30, `serves:${stop.name}`];
      }
      if (score < 0) continue;

      const leg = t.legAt(now);
      if (leg.basis === 'between' || leg.basis === 'at_station') score += 5;
      const next = t.nextCall(now);
      const rec = this.couples.delays.get(t.number);

      out.push({
        number: t.number,
        serviceLabel: meta.label,
        family: meta.family,
        origin: t.origin,
        destination: t.destination,
        delay: rec?.delay ?? t.currentDelay(now),
        cancelled: t.cancelled,
        basis: leg.basis,
        coupledWith: this.couples.partners.get(t.number) ?? [],
        next: next ? { name: next.name, time: next.time, delay: next.delay } : null,
        why,
        score,
      });
    }

    out.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
    // One row per physical train: hide the coupled twin behind the first.
    const seen = new Set<string>();
    const merged: SuggestionDTO[] = [];
    for (const r of out) {
      if (seen.has(r.number)) continue;
      for (const n of r.coupledWith) seen.add(n);
      merged.push(r);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  /**
   * Full journey as drawable geometry: the track-following polyline for every
   * leg, plus the stops.
   */
  journeyGeo(train: TrainDTO): JourneyGeo {
    const coords: [number, number][] = [];
    let covered = 0;
    let total = 0;
    for (let i = 0; i < train.calls.length - 1; i++) {
      const a = train.calls[i]!;
      const b = train.calls[i + 1]!;
      const leg = this.rail?.path(a.lat, a.lon, b.lat, b.lon);
      total++;
      if (leg) {
        covered++;
        for (const [lat, lon] of leg.pts) {
          const last = coords[coords.length - 1];
          if (!last || last[0] !== lon || last[1] !== lat) coords.push([lon, lat]);
        }
      } else {
        coords.push([a.lon, a.lat], [b.lon, b.lat]);
      }
    }
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { number: train.number, legsWithGeometry: covered, legs: total },
        },
        ...train.calls.map((c, i) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] as [number, number] },
          properties: {
            name: c.name,
            time: c.time,
            delay: c.delay,
            index: i,
            terminus: (i === train.calls.length - 1 ? 1 : 0) as 0 | 1,
          },
        })),
      ],
    };
  }

  stats(): StatsDTO {
    const now = Math.floor(Date.now() / 1000);
    const byFamily: Partial<Record<Family, number>> = {};
    let delayed = 0;
    let cancelled = 0;
    for (const t of this.trains) {
      const f = serviceMeta(t.service).family;
      byFamily[f] = (byFamily[f] ?? 0) + 1;
      if (t.currentDelay(now) >= 300) delayed++;
      if (t.cancelled) cancelled++;
    }
    return {
      total: this.trains.length,
      byFamily,
      delayed,
      cancelled,
      feedTs: this.feedTs,
      fetchedAt: this.fetchedAt,
      ageSec: this.feedTs ? now - this.feedTs : null,
      stale: this.fromSnapshot,
      replay: this.replay,
      error: this.error,
    };
  }
}
