/**
 * GTFS-RT trip updates for the SNCF network (TGV / Intercités / TER).
 *
 * Keyless, public, refreshed every ~2 min, forecasting ~8 h ahead — and down
 * often enough that retries, a replay mode and a fallback capture all earn
 * their place.
 */

import { readFile } from 'node:fs/promises';
import pkg from 'gtfs-realtime-bindings';
import type { Call } from '../shared/types.ts';
import type { GtfsStatic } from './GtfsStatic.ts';

const { transit_realtime: rtb } = pkg;

export interface FeedOptions {
  url?: string;
  /** Replay a captured .pb instead of calling the network. */
  file?: string | null;
  /** 'auto' rebases the capture onto now, 'none' keeps its clock, or seconds. */
  shift?: string;
  /** Capture served as a last resort when the live fetch fails. */
  fallback?: string | null;
  attempts?: number;
  timeoutMs?: number;
}

/** One decoded trip, before any store-level enrichment. */
export interface RawTrain {
  id: string;
  number: string;
  service: string | null;
  line: string;
  origin: string;
  destination: string;
  calls: Call[];
  cancelled: boolean;
  maxDelay: number;
  lastDelay: number;
  feedTs: number;
}

export interface FeedResult {
  trains: RawTrain[];
  feedTs: number;
  /** True when the data came from a capture rather than the live feed. */
  replay: boolean;
  shift: number;
}

const ID_RE = /^OCE([A-Z]{2})(\d+)F/;
const DEFAULT_URL = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** protobuf Long or plain number, depending on magnitude. */
type MaybeLong = number | { toNumber(): number } | null | undefined;
const num = (v: MaybeLong): number | null => {
  if (v == null) return null;
  return typeof v === 'object' ? v.toNumber() : v;
};

export class FeedClient {
  private readonly url: string;
  private readonly file: string | null;
  private readonly shiftMode: string;
  private readonly fallback: string | null;
  private readonly attempts: number;
  private readonly timeoutMs: number;

  constructor(opts: FeedOptions = {}) {
    this.url = opts.url ?? process.env['SNCF_FEED_URL'] ?? DEFAULT_URL;
    this.file = opts.file ?? process.env['SNCF_FEED_FILE'] ?? null;
    this.shiftMode = opts.shift ?? process.env['SNCF_FEED_SHIFT'] ?? 'auto';
    this.fallback = opts.fallback ?? process.env['SNCF_FEED_FALLBACK'] ?? null;
    this.attempts = opts.attempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async decodeFile(file: string): Promise<{ msg: unknown; replay: true }> {
    const buf = await readFile(file);
    return { msg: rtb.FeedMessage.decode(new Uint8Array(buf)), replay: true };
  }

  /**
   * Fetch and decode the feed.
   *
   * The proxy resets TLS connections often enough that a single attempt is not
   * good enough to boot on: retry with backoff, and give the request a deadline
   * so a hung socket cannot stall the poll loop.
   */
  private async fetchMessage(): Promise<{ msg: unknown; replay: boolean }> {
    if (this.file) return this.decodeFile(this.file);

    let lastErr: unknown;
    for (let i = 0; i < this.attempts; i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          headers: { 'accept-encoding': 'gzip' },
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`GTFS-RT fetch failed: HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        return { msg: rtb.FeedMessage.decode(buf), replay: false };
      } catch (e) {
        lastErr = e;
        if (i < this.attempts - 1) await sleep(500 * 2 ** i);
      } finally {
        clearTimeout(timer);
      }
    }

    // Last resort: serve a capture rather than an empty network. Always
    // reported as replay so the page can label it — demo data must never
    // masquerade as live.
    if (this.fallback) {
      try {
        return await this.decodeFile(this.fallback);
      } catch {
        /* fall through to the real error */
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`GTFS-RT unavailable after ${this.attempts} attempts: ${msg}`);
  }

  /** Decode the feed into normalised trains. */
  async load(statics: GtfsStatic): Promise<FeedResult> {
    const { msg, replay } = await this.fetchMessage();
    const feed = msg as { header: { timestamp: MaybeLong }; entity: unknown[] };
    const rawTs = num(feed.header.timestamp) ?? 0;

    let shift = 0;
    if (replay && this.shiftMode !== 'none') {
      shift =
        this.shiftMode === 'auto'
          ? Math.floor(Date.now() / 1000) - rawTs
          : Number(this.shiftMode) || 0;
    }
    const feedTs = rawTs + shift;

    const trains: RawTrain[] = [];
    for (const e of feed.entity) {
      const t = this.buildTrain(e, statics, feedTs, shift);
      if (t) trains.push(t);
    }
    return { trains, feedTs, replay, shift };
  }

  /**
   * Turn one trip_update into a normalised train.
   * Every time here is SNCF's own live forecast — not interpolated.
   */
  private buildTrain(
    entity: unknown,
    statics: GtfsStatic,
    feedTs: number,
    shift: number,
  ): RawTrain | null {
    const e = entity as {
      id: string;
      tripUpdate?: {
        trip?: { scheduleRelationship?: number };
        stopTimeUpdate?: Array<{
          stopId: string;
          arrival?: { time?: MaybeLong; delay?: MaybeLong };
          departure?: { time?: MaybeLong; delay?: MaybeLong };
          scheduleRelationship?: number;
        }>;
      };
    };
    const m = ID_RE.exec(e.id);
    if (!m) return null;
    const tu = e.tripUpdate;
    if (!tu?.stopTimeUpdate?.length) return null;

    const meta = statics.trains.get(`${m[1]}${m[2]}`);
    const cancelled = tu.trip?.scheduleRelationship === 3; // CANCELED

    const calls: Call[] = [];
    for (const stu of tu.stopTimeUpdate) {
      const stop = statics.stops.get(stu.stopId);
      if (!stop) continue;
      const rawAt = num(stu.departure?.time) || num(stu.arrival?.time);
      if (!rawAt) continue;
      const delay = num(stu.departure?.delay) ?? num(stu.arrival?.delay) ?? 0;
      const arr = num(stu.arrival?.time);
      const dep = num(stu.departure?.time);
      calls.push({
        stopId: stu.stopId,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        arrival: arr ? arr + shift : null,
        departure: dep ? dep + shift : null,
        time: rawAt + shift,
        delay,
        skipped: stu.scheduleRelationship === 1, // SKIPPED
      });
    }
    if (calls.length < 2) return null;
    calls.sort((a, b) => a.time - b.time);

    return {
      id: e.id,
      number: m[2]!,
      service: meta?.service ?? null,
      line: meta?.line ?? '',
      origin: calls[0]!.name,
      destination: calls[calls.length - 1]!.name,
      calls,
      cancelled,
      maxDelay: Math.max(...calls.map((c) => c.delay)),
      lastDelay: calls[calls.length - 1]!.delay,
      feedTs,
    };
  }
}
