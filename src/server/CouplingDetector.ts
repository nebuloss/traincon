/**
 * Detects units running coupled (unité multiple).
 *
 * Two portions from different origins are routinely joined at an intermediate
 * stop and run to the terminus as one physical train, keeping separate train
 * numbers. SNCF publishes a record per number and updates them independently,
 * so one goes stale: 8540 sat at +70 all the way to Paris while its twin 8582
 * had already been corrected to +50 — the figure SNCF Connect showed, and the
 * one that matched reality.
 *
 * This class finds those pairs and reconciles them.
 */

import type { RailGraph } from './RailGraph.ts';
import type { Train } from './Train.ts';
import type { Call, Position, Reconciliation } from '../shared/types.ts';

/** Generous, deliberately: the point is to reconcile numbers that disagree. */
const DELAY_TOL = 40 * 60;
/** Booked into the terminus within this many seconds of each other. */
const SCHED_TOL = 4 * 60;
/** Below this spread the numbers agree well enough not to flag it. */
const DISAGREEMENT_MIN = 5 * 60;

interface Member {
  train: Train;
  delay: number;
  /** Scheduled arrival at the terminus — stable whatever the live times say. */
  schedTerminus: number;
  /** Stop the train is heading for. */
  toward: string | null;
  /** Fraction along the current leg, for picking the most advanced member. */
  legF: number;
}

export interface CouplingResult {
  /** number -> the other numbers of its set. */
  partners: Map<string, string[]>;
  /** number -> position shared by the whole set. */
  positions: Map<string, Position>;
  /** number -> reconciled delay and the disagreement behind it. */
  delays: Map<string, Reconciliation>;
  /** number -> calls with the shared tail corrected from the freshest member. */
  calls: Map<string, Call[]>;
}

export class CouplingDetector {
  /** number -> feedTs of its last delay revision, kept across refreshes. */
  private readonly lastChange = new Map<string, number>();

  /** Record that a number's delay changed, so freshness can be compared. */
  noteChange(number: string, feedTs: number): void {
    this.lastChange.set(number, feedTs);
  }

  /** Drop a train that has left the feed, so this map stays bounded. */
  forget(number: string): void {
    this.lastChange.delete(number);
  }

  detect(trains: Train[], now: number, graph: RailGraph | null): CouplingResult {
    const buckets = new Map<string, Member[]>();

    for (const t of trains) {
      const future = t.calls.filter((c) => c.time > now);
      if (!future.length) continue;
      const leg = t.legAt(now);
      if (leg.basis !== 'between' && leg.basis !== 'at_station') continue;

      // Bucket on the terminus, refined below by its scheduled arrival minute.
      //
      // Two services booked into the same terminus at the same minute, heading
      // for the same next stop, are one physical train. Keying on the remaining
      // call sequence fails: the feed had 8540 still standing at Bordeaux while
      // 8582 had departed, so one had two calls left and the other one.
      const last = t.terminus;
      const key = last.stopId;
      let b = buckets.get(key);
      if (!b) {
        b = [];
        buckets.set(key, b);
      }
      b.push({
        train: t,
        delay: t.currentDelay(now),
        schedTerminus: last.time - last.delay,
        toward: leg.b?.stopId ?? null,
        legF: leg.f,
      });
    }

    const result: CouplingResult = {
      partners: new Map(),
      positions: new Map(),
      delays: new Map(),
      calls: new Map(),
    };

    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.schedTerminus - b.schedTerminus || a.delay - b.delay);

      let run: Member[] = [group[0]!];
      const flush = (): void => {
        if (run.length >= 2) this.reconcile(run, now, graph, result);
        run = [];
      };

      for (let i = 1; i < group.length; i++) {
        const cur = group[i]!;
        const prev = run[run.length - 1]!;
        const closeDelay = Math.abs(cur.delay - prev.delay) <= DELAY_TOL;
        const sameSlot = Math.abs(cur.schedTerminus - prev.schedTerminus) <= SCHED_TOL;
        const sameTarget = cur.toward === prev.toward;
        if (closeDelay && sameSlot && sameTarget) run.push(cur);
        else {
          flush();
          run = [cur];
        }
      }
      flush();
    }

    return result;
  }

  private reconcile(
    run: Member[],
    now: number,
    graph: RailGraph | null,
    out: CouplingResult,
  ): void {
    const numbers = run.map((x) => x.train.number);

    // One physical train, one position: take the most advanced reading, since
    // a set that has reached a point has reached it under every number.
    const lead = run.reduce((best, x) => (x.legF > best.legF ? x : best), run[0]!);
    const position = lead.train.positionAt(now, graph);

    // One physical train cannot have two delays. Trust the number whose
    // prediction was revised most recently.
    const freshest = run.reduce((best, x) => {
      const a = this.lastChange.get(x.train.number) ?? 0;
      const b = this.lastChange.get(best.train.number) ?? 0;
      return a > b ? x : best;
    }, run[0]!);

    const delays = run.map((x) => x.delay);
    const spread = Math.max(...delays) - Math.min(...delays);
    const disagreement =
      spread >= DISAGREEMENT_MIN
        ? run.map((x) => ({ number: x.train.number, delay: x.delay }))
        : null;

    // Fixing only the headline figure leaves the timeline lying: 8540 showed
    // "50 min" above a stop list still reading Bordeaux 16:50 / Paris 19:06,
    // while 8582 had 16:30 / 18:46 — exactly what SNCF Connect displayed. Once
    // the portions have joined they call at the same stops at the same moment,
    // so the shared tail takes the freshest member's times.
    const srcCalls = new Map(freshest.train.calls.map((c) => [c.stopId, c]));
    const joinTime = freshest.train.legAt(now).a.time;

    for (const x of run) {
      const n = x.train.number;
      out.partners.set(n, numbers.filter((o) => o !== n));
      out.positions.set(n, position);
      out.delays.set(n, {
        delay: freshest.delay,
        source: freshest.train.number,
        spread,
        disagreement,
      });

      if (n !== freshest.train.number) {
        out.calls.set(
          n,
          x.train.calls.map((c) => {
            const src = srcCalls.get(c.stopId);
            // Only from the join onward: each portion's own earlier stops
            // (Hendaye vs Tarbes here) are genuinely its own.
            return src && src.time >= joinTime ? { ...c, ...src } : c;
          }),
        );
      }
    }
  }
}
