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
import { sampleProfile } from '../shared/motion.ts';
import { Train } from './Train.ts';
import { CouplingDetector, type CouplingResult } from './CouplingDetector.ts';
import { BlockIndex } from './Blocks.ts';
import { DailyBoard } from './DailyBoard.ts';
import { analyseTraffic, bearingDeg, haversineKm, type Traffic } from './Headway.ts';
import { SignalIndex } from './Signals.ts';
import { Disruptions } from './Disruptions.ts';
import type {
  DelaySample,
  Family,
  JourneyGeo,
  Position,
  StatsDTO,
  SuggestionDTO,
  TrainDTO,
  Trend,
  WorstBoardDTO,
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

/**
 * Remove the places where a route doubles back on itself.
 *
 * Each leg is routed independently and the results are laid end to end, so
 * where one leg's approach to a station and the next leg's departure from it
 * disagree about the last few metres, the joined line reverses: it runs on,
 * turns through nearly 180°, and comes back. Measured on a real TGV journey,
 * 25 of about 5 000 vertices turned by more than 30° and the worst was a full
 * 180.
 *
 * That is invisible as a drawn line — the spur is metres long — but a train
 * advancing steadily along the line physically moves backwards and then
 * forwards again as it crosses one. Which is exactly what it looks like.
 *
 * So a vertex is dropped when the path turns almost back on itself there and
 * the spur is short. Real track has tight curves, but not a reversal inside
 * 250 m; that is a routing artefact, not a railway.
 */
function despike(coords: [number, number][]): [number, number][] {
  if (coords.length < 3) return coords;

  const REVERSAL_COS = Math.cos((160 * Math.PI) / 180);
  const SPUR_M = 250;

  // Local, flat-earth metres: distances here are tens of metres, so the
  // curvature of the planet is irrelevant and this avoids a trig call per
  // vertex on a five-thousand-point line.
  const mPerDegLat = 111_320;
  const out: [number, number][] = [coords[0]!];

  for (let i = 1; i < coords.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const here = coords[i]!;
    const next = coords[i + 1]!;

    const mPerDegLon = mPerDegLat * Math.cos((here[1]! * Math.PI) / 180);
    const ax = (here[0]! - prev[0]!) * mPerDegLon;
    const ay = (here[1]! - prev[1]!) * mPerDegLat;
    const bx = (next[0]! - here[0]!) * mPerDegLon;
    const by = (next[1]! - here[1]!) * mPerDegLat;

    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la === 0) continue; // duplicate vertex, nothing to draw
    if (lb === 0 || Math.min(la, lb) > SPUR_M) {
      out.push(here);
      continue;
    }

    // cos of the turn: -1 is a full reversal, +1 is straight on.
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos > REVERSAL_COS) out.push(here);
  }

  out.push(coords[coords.length - 1]!);
  return out;
}

/**
 * De-spike until it settles.
 *
 * Removing a vertex makes its neighbours adjacent, which can expose a
 * reversal that was hidden behind it. On a real TGV journey one pass took 14
 * reversals down to 6 and three passes to 3; the rest are joins where a leg
 * with no routed geometry meets real track at an angle, which is the route's
 * actual shape rather than an artefact.
 */
function smoothRoute(coords: [number, number][]): [number, number][] {
  let out = coords;
  for (let pass = 0; pass < 4; pass++) {
    const next = despike(out);
    if (next.length === out.length) break;
    out = next;
  }
  return out;
}

export class TrainStore {
  private statics!: GtfsStatic;
  private rail: RailGraph | null = null;
  private readonly feed: FeedClient;
  private readonly coupling = new CouplingDetector();
  private readonly disruptions = new Disruptions();
  private blocks: BlockIndex | null = null;
  private signals: SignalIndex | null = null;
  /** Train number -> what the traffic ahead of it implies. */
  private traffic = new Map<string, Traffic>();
  private readonly board: DailyBoard;

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
    this.board = new DailyBoard(dataDir);
  }

  get stations(): GtfsStatic {
    return this.statics;
  }

  async start(): Promise<void> {
    this.statics = await GtfsStatic.load(this.dataDir);
    await this.board.load();
    // Spacing is a refinement: without it every train is placed as if the line
    // were empty, which is what it did before.
    this.blocks = await BlockIndex.load(this.dataDir);
    this.signals = await SignalIndex.load(this.dataDir);
    // Optional and key-gated: without one the board still ranks, it just
    // cannot say why.
    this.disruptions.start();
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
    this.disruptions.stop();
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

    this.traffic = this.analyseSpacing(now);

    // Record the day's worst before pruning drops anything. The raw trains,
    // not list(): that builds a DTO per train, routing each one over the rail
    // graph, and doing it every minute exhausted the heap.
    this.board.observe(this.trains, serviceMeta, now);
    void this.board.save().catch(() => undefined);

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
      traffic: this.traffic.get(train.number) ?? null,
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
  /**
   * Which trains are running into the back of which.
   *
   * Deliberately built from a cheap straight-line position rather than the
   * routed one: this runs for every train on every refresh, and computing full
   * positions here is exactly what exhausted the heap in v2.3.0. Spacing only
   * needs to know which train is in front and roughly how far, and a
   * kilometre-scale answer is enough for a block that is kilometres long.
   */
  private analyseSpacing(now: number): Map<string, Traffic> {
    // Either source will do. The signalling layer is the better one — it gives
    // the real distance to the signal that would stop the train — and the
    // block-working mode is the fallback where it has nothing.
    if (!this.signals && !this.blocks) return new Map();

    const followers = [];
    for (const t of this.trains) {
      if (!t.line) continue;
      const leg = t.legAt(now);
      if (leg.basis !== 'between' || !leg.b) continue;

      const { a, b, f } = leg;
      const span = Math.max(1, (leg.span ?? 0) / 3600);
      const km = haversineKm(a.lat, a.lon, b.lat, b.lon);

      const lat = a.lat + (b.lat - a.lat) * f;
      const lon = a.lon + (b.lon - a.lon) * f;

      // Group on the infrastructure line, not the commercial one: two trains
      // sharing a track routinely carry different service labels, so grouping
      // by those found almost no pairs at all.
      const line = this.signals?.lineAt(lat, lon) ?? t.line;
      if (!line) continue;

      followers.push({
        number: t.number,
        line,
        position: {
          basis: 'between' as const,
          lat,
          lon,
          bearing: bearingDeg(a.lat, a.lon, b.lat, b.lon),
          progress: (leg.i + f) / Math.max(1, t.calls.length - 1),
          speedKmh: Math.round(km / span),
        } as Position,
      });
    }

    return analyseTraffic(
      followers,
      // 1 800 m is a typical lit block, and stands in where the mode table is
      // not available.
      (lat, lon) => this.blocks?.spacingNear(lat, lon) ?? 1800,
      this.signals
        ? (lat, lon, bearing) => this.signals!.nextAhead(lat, lon, bearing)?.distanceM ?? null
        : undefined,
    );
  }

  /** The day's worst delays, with a cause where the feed gives one. */
  worst(limit = 25): WorstBoardDTO {
    const live = new Set(this.trains.map((t) => t.number));
    return {
      day: this.board.day_,
      reasonsAvailable: this.disruptions.enabled,
      trains: this.board.top(limit, {
        live: (n) => live.has(n),
        reason: (n) => this.disruptions.get(n)?.reason ?? null,
      }),
    };
  }

  journeyGeo(train: TrainDTO): JourneyGeo {
    const coords: [number, number][] = [];
    // One motion profile per leg, so the map can run the same model the
    // server does — see src/shared/motion.ts. Without it the client can only
    // assume constant speed, which drifts from the server's answer by
    // kilometres on a leg with real acceleration and braking.
    const legProfiles: number[][] = [];
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
        // Four decimals is a ten-thousandth of a leg: centimetres on the
        // longest of them, and it keeps the payload to a few kilobytes.
        legProfiles.push(sampleProfile(leg.cum, leg.cumT).map((x) => Math.round(x * 1e4) / 1e4));
      } else {
        coords.push([a.lon, a.lat], [b.lon, b.lat]);
        legProfiles.push([]);
      }
    }
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: smoothRoute(coords) },
          properties: {
            number: train.number,
            legsWithGeometry: covered,
            legs: total,
            legProfiles,
          },
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

  /**
   * What the process is using, in MB.
   *
   * This has died twice on the V8 heap ceiling, and both times the only
   * evidence was RSS sampled from outside — which includes everything the heap
   * is not, so it could never say how close the limit actually was. `limit` is
   * the ceiling the installer set, so the three numbers together answer it.
   */
  /**
   * How big each retained structure is.
   *
   * The process has died on the heap ceiling three times, and each diagnosis
   * so far has been inference from a single total. These are the only things
   * that live longer than one refresh, so whichever of them is growing is the
   * answer — and if none of them is, the leak is not here.
   */
  private retained(): NonNullable<StatsDTO['memory']>['retained'] {
    return {
      trains: this.trains.length,
      history: this.history.size,
      historySamples: [...this.history.values()].reduce((n, h) => n + h.length, 0),
      lastSeen: this.lastSeen.size,
      board: this.board.size,
      disruptions: this.disruptions.size,
      paths: this.rail?.cacheStats.paths ?? 0,
      pathPoints: this.rail?.cacheStats.points ?? 0,
    };
  }

  private static memory(): Omit<NonNullable<StatsDTO['memory']>, 'retained'> {
    const m = process.memoryUsage();
    const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
    const cap = /--max-old-space-size=(\d+)/.exec(process.env['NODE_OPTIONS'] ?? '');
    return {
      heapUsed: mb(m.heapUsed),
      heapTotal: mb(m.heapTotal),
      rss: mb(m.rss),
      limit: cap ? Number(cap[1]) : null,
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
      memory: { ...TrainStore.memory(), retained: this.retained() },
    };
  }
}
