/**
 * The day's worst delays.
 *
 * The live store cannot answer this on its own: the feed is a rolling ~8 hour
 * forward window and trains are pruned two hours after they leave it, so by
 * evening the morning's disasters are long gone. This keeps a high-water mark
 * per train for the current day instead — once a train has been 3 h 30 down it
 * stays on the board even after it has finished its run and vanished.
 *
 * Persisted, because a restart mid-afternoon should not wipe the morning, and
 * reset on the Paris date rolling over — the timetable's own day boundary.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Family, TrainDTO, WorstTrainDTO } from '../shared/types.ts';

/** Below this a train is not interesting enough to record. */
const MIN_DELAY = 10 * 60;
/** Cap the board so a bad day cannot grow the file without bound. */
const MAX_ENTRIES = 400;

interface Entry {
  number: string;
  serviceLabel: string;
  family: Family;
  origin: string;
  destination: string;
  /** Worst delay seen today, in seconds. */
  delay: number;
  /** When that peak was recorded, epoch seconds. */
  at: number;
  cancelled: boolean;
}

export class DailyBoard {
  private entries = new Map<string, Entry>();
  private day = '';
  private dirty = false;

  constructor(private readonly dataDir = 'data') {}

  private get file(): string {
    return path.join(this.dataDir, 'daily-board.json');
  }

  /**
   * Today's date in Paris, as YYYY-MM-DD.
   *
   * Assembled from parts rather than asking a locale for ISO order: Alpine's
   * Node is built with reduced ICU data, so 'en-CA' falls back to en-US and
   * this returned "8/28/2026" in production while being correct on dev.
   */
  static today(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  async load(): Promise<void> {
    this.day = DailyBoard.today();
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as {
        day?: string;
        entries?: Entry[];
      };
      // Yesterday's board is not today's: start clean rather than showing
      // stale records under today's heading.
      if (raw.day !== this.day) return;
      for (const e of raw.entries ?? []) this.entries.set(e.number, e);
    } catch {
      /* first run, or an unreadable file — start empty */
    }
  }

  /** Fold the current snapshot into the day's records. */
  observe(trains: TrainDTO[], now = Math.floor(Date.now() / 1000)): void {
    const today = DailyBoard.today();
    if (today !== this.day) {
      this.day = today;
      this.entries.clear();
      this.dirty = true;
    }

    for (const t of trains) {
      // A cancelled train has no meaningful delay but absolutely belongs here.
      if (!t.cancelled && t.worstDelay < MIN_DELAY) continue;

      const prev = this.entries.get(t.number);
      if (prev && !t.cancelled && t.worstDelay <= prev.delay) continue;

      this.entries.set(t.number, {
        number: t.number,
        serviceLabel: t.serviceLabel,
        family: t.family,
        origin: t.origin,
        destination: t.destination,
        delay: Math.max(t.worstDelay, prev?.delay ?? 0),
        at: prev && t.worstDelay <= (prev.delay ?? 0) ? prev.at : now,
        cancelled: t.cancelled || Boolean(prev?.cancelled),
      });
      this.dirty = true;
    }

    if (this.entries.size > MAX_ENTRIES) this.trim();
  }

  /** Keep only the worst, so the file stays small on a bad day. */
  private trim(): void {
    const kept = [...this.entries.values()]
      .sort((a, b) => b.delay - a.delay)
      .slice(0, MAX_ENTRIES);
    this.entries = new Map(kept.map((e) => [e.number, e]));
  }

  /**
   * The ranking, worst first.
   *
   * `live` and `reason` are filled by the caller, which owns the current
   * snapshot and the disruption index.
   */
  top(
    limit: number,
    opts: { live: (n: string) => boolean; reason: (n: string) => string | null },
  ): WorstTrainDTO[] {
    return [...this.entries.values()]
      .sort((a, b) => b.delay - a.delay || a.number.localeCompare(b.number))
      .slice(0, limit)
      .map((e) => ({ ...e, live: opts.live(e.number), reason: opts.reason(e.number) }));
  }

  get day_(): string {
    return this.day;
  }

  get size(): number {
    return this.entries.size;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify({ day: this.day, entries: [...this.entries.values()] });
    await writeFile(this.file, body).catch(() => undefined);
  }
}
