/**
 * Why trains are late, from the SNCF/Navitia disruption feed.
 *
 * The GTFS-RT export carries delays but no cause, so the reason has to come
 * from elsewhere. Navitia publishes a disruption per affected journey with a
 * plain-French message — "Obstacle sur la voie", "Défaillance de matériel" —
 * and `impacted_objects[].pt_object.trip.name` is the train number, which is
 * exactly the key the store is built on.
 *
 * Optional: without a key the index stays empty and the rest of the app is
 * unaffected. Ranking works either way; only the reason column goes quiet.
 *
 * Two things drove the design:
 *
 * - Sweep, do not query per train. The obvious approach — ask Navitia about
 *   the twenty trains being displayed — does not work: filtering
 *   vehicle_journeys by has_headsign returns unrelated coach services, 0 hits
 *   on 20 known-delayed trains. Paging the whole disruption list and indexing
 *   by number matched 72% of them.
 * - The free key allows 5 000 requests a day. A full sweep is ~18 pages, so a
 *   15-minute cycle costs ~1 700 a day and leaves room for everything else.
 */

const BASE = process.env['SNCF_API_BASE'] || 'https://api.sncf.com/v1/coverage/sncf';
const PAGE = 200;
/** Enough for the ~3 500 disruptions seen in practice, with headroom. */
const MAX_PAGES = 25;
const REFRESH_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export interface Disruption {
  /** Plain-French cause, as SNCF words it. */
  reason: string;
  /** Navitia's effect code, e.g. SIGNIFICANT_DELAYS, NO_SERVICE. */
  effect: string;
}

interface NavitiaDisruption {
  severity?: { effect?: string };
  messages?: { text?: string }[];
  impacted_objects?: {
    pt_object?: { trip?: { name?: string } };
    impacted_stops?: { cause?: string }[];
  }[];
}

export class Disruptions {
  private index = new Map<string, Disruption>();
  private timer: NodeJS.Timeout | null = null;

  /** Last successful sweep, epoch ms; 0 until one lands. */
  fetchedAt = 0;
  error: string | null = null;

  constructor(private readonly key = process.env['SNCF_API_KEY']?.trim() || null) {}

  /** Whether reasons can be shown at all. */
  get enabled(): boolean {
    return Boolean(this.key);
  }

  get size(): number {
    return this.index.size;
  }

  /** The reason a train is disrupted today, if the feed names one. */
  get(number: string): Disruption | null {
    return this.index.get(number) ?? null;
  }

  start(): void {
    if (!this.key || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Rebuild the index.
   *
   * Built into a new map and swapped in at the end, so a sweep that fails
   * halfway leaves the previous answers in place rather than a partial set.
   */
  async refresh(): Promise<void> {
    if (!this.key) return;

    const next = new Map<string, Disruption>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const items = await this.page(page);
        if (!items.length) break;
        for (const d of items) this.absorb(d, next);
      }
      this.index = next;
      this.fetchedAt = Date.now();
      this.error = null;
    } catch (e) {
      // Keep the last good index: a stale reason is better than none, and the
      // ranking must not depend on this call succeeding.
      this.error = (e as Error).message;
    }
  }

  private async page(page: number): Promise<NavitiaDisruption[]> {
    const url = new URL(`${BASE}/disruptions`);
    url.searchParams.set('count', String(PAGE));
    url.searchParams.set('start_page', String(page));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          // Basic auth, token as username, empty password.
          authorization: 'Basic ' + Buffer.from(this.key + ':').toString('base64'),
          accept: 'application/json',
        },
      });
      if (res.status === 401) throw new Error('SNCF API key refused (401)');
      if (res.status === 429) throw new Error('SNCF API quota exhausted (429)');
      if (!res.ok) throw new Error(`SNCF API HTTP ${res.status}`);
      const body = (await res.json()) as { disruptions?: NavitiaDisruption[] };
      return body.disruptions ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Index one disruption under every train number it names. */
  private absorb(d: NavitiaDisruption, into: Map<string, Disruption>): void {
    const effect = d.severity?.effect ?? '';
    const headline = d.messages?.find((m) => m.text)?.text;

    for (const obj of d.impacted_objects ?? []) {
      const number = obj.pt_object?.trip?.name?.trim();
      if (!number) continue;

      // The per-stop cause is the same text in practice, but it is present on
      // some disruptions that carry no top-level message.
      const reason = headline ?? obj.impacted_stops?.find((s) => s.cause)?.cause;
      if (!reason) continue;

      // First writer wins: pages come back newest-first, and a train that has
      // had two incidents should show the current one.
      if (!into.has(number)) into.set(number, { reason, effect });
    }
  }
}
