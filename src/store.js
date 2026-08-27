// In-memory store: keeps the current feed snapshot plus a short delay history
// per train, so the UI can show whether a delay is growing or recovering.
import { loadStatic, SERVICE_LABELS } from './gtfs.js';
import { loadTrains, positionOf, nextCall, legAt, currentDelay } from './realtime.js';
import { loadRailGraph } from './railgraph.js';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const POLL_MS = 60_000;
const STATIC_REFRESH_MS = 12 * 3600 * 1000;
const HISTORY_MAX = 60; // ~1 h of samples

export class Store {
  constructor(dataDir = 'data') {
    this.dataDir = dataDir;
    this.statics = null;
    this.trains = [];
    this.byNumber = new Map();
    this.feedTs = 0;
    this.fetchedAt = 0;
    this.history = new Map(); // number -> [{ t, delay }]
    this.coupled = new Map();  // number -> [numbers running coupled]
    this.lastChange = new Map(); // number -> feedTs of its last delay revision
    this.stickyCoupled = new Map(); // number -> group id, kept once established
    this.couplePos = new Map();
    this.error = null;
    this.timer = null;
    this.rail = null;   // RailGraph, optional
    this.railDisplayGz = null;  // pre-gzipped display network — positions fall back to great circles
  }

  async start() {
    this.statics = await loadStatic(this.dataDir);
    try {
      this.rail = await loadRailGraph(this.dataDir);
      if (this.rail.display) {
        this.railDisplayGz = gzipSync(Buffer.from(JSON.stringify(this.rail.display)), { level: 9 });
      }
    } catch (e) {
      console.warn('géométrie ferroviaire indisponible, repli ligne droite:', e.message);
    }
    // A transient feed failure must not stop the server from coming up: serve
    // the last good snapshot if we have one, and let the poller take over.
    try {
      await this.refresh();
    } catch (e) {
      this.error = String(e.message ?? e);
      console.warn('flux temps réel indisponible au démarrage :', this.error);
      const n = await this.loadSnapshot();
      console.warn(n
        ? `reprise sur le dernier instantané : ${n} trains, nouvel essai dans 60 s`
        : 'aucun instantané disponible, nouvel essai dans 60 s');
    }
    this.timer = setInterval(() => {
      this.refresh().catch((e) => { this.error = String(e.message ?? e); });
    }, POLL_MS);
    this.timer.unref?.();
  }

  async refresh() {
    if (Date.now() - this.statics.loadedAt > STATIC_REFRESH_MS) {
      try { this.statics = await loadStatic(this.dataDir); } catch { /* keep old */ }
    }
    const { trains, feedTs, replay } = await loadTrains(this.statics);
    const now = Math.floor(Date.now() / 1000);
    this.replay = Boolean(replay);
    this.trains = trains;
    this.feedTs = feedTs;
    this.fetchedAt = Date.now();
    this.error = null;
    this.fromSnapshot = false;

    this.saveSnapshot().catch(() => { /* cache only */ });

    this.byNumber = new Map();
    for (const t of trains) {
      if (!this.byNumber.has(t.number)) this.byNumber.set(t.number, []);
      this.byNumber.get(t.number).push(t);

      const cur = currentDelay(t, now);
      const h = this.history.get(t.number) ?? [];
      const last = h[h.length - 1];
      if (!last || last.delay !== cur) {
        h.push({ t: feedTs, delay: cur });
        if (h.length > HISTORY_MAX) h.shift();
        this.history.set(t.number, h);
        this.lastChange.set(t.number, feedTs);
      }
    }
    this.detectCoupling();
  }

  // Replay writes to its own file: a dev session must never overwrite the
  // production cache with time-shifted fixture data.
  get snapshotFile() {
    return path.join(this.dataDir,
      process.env.SNCF_FEED_FILE ? 'last-feed.replay.json' : 'last-feed.json');
  }

  /** Never cache replayed data as if it were a real observation. */
  get canSnapshot() {
    return !this.replay;
  }

  /**
   * Keep the last good decode on disk.
   *
   * The upstream proxy goes down from time to time; without this a restart
   * during an outage leaves the app with nothing to show. Stale data clearly
   * marked as stale beats an empty screen.
   */
  async saveSnapshot() {
    if (!this.trains.length || !this.canSnapshot) return;
    await writeFile(this.snapshotFile,
      JSON.stringify({ feedTs: this.feedTs, savedAt: Date.now(), trains: this.trains }));
  }

  async loadSnapshot() {
    try {
      const raw = JSON.parse(await readFile(this.snapshotFile, 'utf8'));
      if (!Array.isArray(raw.trains) || !raw.trains.length) return 0;
      this.trains = raw.trains;
      this.feedTs = raw.feedTs ?? 0;
      this.fetchedAt = raw.savedAt ?? 0;
      this.fromSnapshot = true;
      this.byNumber = new Map();
      for (const t of this.trains) {
        if (!this.byNumber.has(t.number)) this.byNumber.set(t.number, []);
        this.byNumber.get(t.number).push(t);
      }
      this.detectCoupling();
      return this.trains.length;
    } catch { return 0; }
  }

  /**
   * Detect units running coupled (unité multiple).
   *
   * Two portions from different origins are routinely joined at an
   * intermediate stop and run to the terminus as one physical train, keeping
   * separate train numbers. The feed publishes them as two trips and their
   * predicted times can drift apart, so the map would otherwise show two
   * trains where one is running.
   *
   * Heuristic: same next two calls, in the same order, with next-stop times
   * within COUPLE_TOL. Kept deliberately narrow — a shared next stop alone is
   * just two trains heading the same way.
   */
  detectCoupling(now = Math.floor(Date.now() / 1000)) {
    // Generous, deliberately: the whole point is to reconcile numbers that
    // disagree, and 8540/8582 differed by 20 min. The terminus key below is
    // specific enough to carry that width.
    const DELAY_TOL = 40 * 60;
    const SCHED_TOL = 4 * 60;
    const buckets = new Map();

    for (const t of this.trains) {
      const future = t.calls.filter((c) => c.time > now);
      if (!future.length) continue;
      const leg = legAt(t, now);
      if (leg.basis !== 'between' && leg.basis !== 'at_station') continue;

      // Bucket on the terminus, refined below by its scheduled arrival minute.
      //
      // Two services booked into the same terminus at the same minute, heading
      // for the same next stop, are one physical train — that is 8540 and 8582,
      // both due Paris Montparnasse at 17:56. Keying on the remaining call
      // sequence fails here: the feed still had 8540 standing at Bordeaux while
      // 8582 had departed, so one had two calls left and the other one. The
      // scheduled terminus is stable whatever each number's live times claim.
      const last = t.calls[t.calls.length - 1];
      const schedTerminus = last.time - last.delay;
      const key = last.stopId;

      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push({ t, delay: currentDelay(t, now), leg, toward: leg.b?.stopId ?? null, schedTerminus });
    }

    this.coupled = new Map();  // number -> [other numbers]
    this.couplePos = new Map(); // number -> position shared by the group
    this.coupleDelay = new Map(); // number -> reconciled delay for the group
    this.coupleCalls = new Map(); // number -> calls with the shared tail corrected
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.schedTerminus - b.schedTerminus || a.delay - b.delay);
      let run = [group[0]];
      const flush = () => {
        if (run.length >= 2) {
          const nums = run.map((x) => x.t.number);
          // One physical train, one position: take the most advanced reading,
          // since a set that has reached a point has reached it for every
          // number it runs under.
          const lead = run.reduce((best, x) =>
            (x.leg.f ?? 0) > (best.leg.f ?? 0) ? x : best, run[0]);
          const pos = positionOf(lead.t, now, this.rail);

          // One physical train cannot have two delays. The feed publishes a
          // value per number and updates them independently, so one goes
          // stale: 8540 sat at +70 while its coupled twin 8582 had already
          // been corrected to +50 (the value SNCF Connect showed). Trust the
          // number whose prediction was revised most recently.
          const freshest = run.reduce((best, x) => {
            const a = this.lastChange.get(x.t.number) ?? 0;
            const b = this.lastChange.get(best.t.number) ?? 0;
            return a > b ? x : best;
          }, run[0]);
          const delays = run.map((x) => currentDelay(x.t, now));
          const spread = Math.max(...delays) - Math.min(...delays);

          const groupId = nums.slice().sort().join('+');
          // Fixing only the headline figure leaves the timeline lying: 8540
          // showed "50 min" above a stop list still reading Bordeaux 16:50 /
          // Paris 19:06, while its twin 8582 — the number SNCF keeps current —
          // had 16:30 / 18:46, exactly what SNCF Connect displays. Once the
          // portions have joined they call at the same stops at the same
          // moment, so the shared tail takes the freshest member's times.
          const srcCalls = new Map(freshest.t.calls.map((c) => [c.stopId, c]));
          for (const x of run) {
            if (x.t.number !== freshest.t.number) {
              const merged = x.t.calls.map((c) => {
                const src = srcCalls.get(c.stopId);
                // Only from the join onward: each portion's own earlier stops
                // (Hendaye vs Tarbes here) are genuinely its own.
                return src && src.time >= freshest.leg.a.time ? { ...c, ...src } : c;
              });
              this.coupleCalls.set(x.t.number, merged);
            }
            // Remember the pairing so it survives into the final leg.
            this.stickyCoupled.set(x.t.number, groupId);
            this.coupled.set(x.t.number, nums.filter((n) => n !== x.t.number));
            this.couplePos.set(x.t.number, pos);
            this.coupleDelay.set(x.t.number, {
              delay: currentDelay(freshest.t, now),
              source: freshest.t.number,
              spread,
              disagreement: spread >= 300
                ? nums.map((n) => {
                    const m = run.find((y) => y.t.number === n);
                    return { number: n, delay: m ? currentDelay(m.t, now) : null };
                  })
                : null,
            });
          }
        }
        run = [];
      };
      for (let i = 1; i < group.length; i++) {
        const prev = run[run.length - 1];
        const closeDelay = Math.abs(group[i].delay - prev.delay) <= DELAY_TOL;
        // Booked into the terminus at the same minute (give or take), and
        // heading for the same next stop. A shared terminus alone would merge
        // services that merely happen to be timetabled alike.
        const sameSlot = Math.abs(group[i].schedTerminus - prev.schedTerminus) <= SCHED_TOL;
        const sameTarget = group[i].toward === prev.toward;
        if (closeDelay && sameSlot && sameTarget) run.push(group[i]);
        else { flush(); run = [group[i]]; }
      }
      flush();
    }
    return this.coupled;
  }

  /** Delay trend over the retained history: 'worsening' | 'recovering' | 'stable'. */
  trend(number) {
    const h = this.history.get(number);
    if (!h || h.length < 2) return 'stable';
    const d = h[h.length - 1].delay - h[0].delay;
    if (d >= 120) return 'worsening';
    if (d <= -120) return 'recovering';
    return 'stable';
  }

  decorate(train, now = Math.floor(Date.now() / 1000)) {
    const meta = SERVICE_LABELS[train.service] ?? { label: train.service ?? 'Train', family: 'other' };
    const rec = this.coupleDelay?.get(train.number) ?? null;
    const own = currentDelay(train, now);
    // A coupled rame is one physical train: it arrives once, at one time.
    // SNCF publishes a record per number and lets one go stale — on 8540 that
    // meant 19:06 while the train was actually due 18:46 under 8582. Take the
    // freshest number's times for the shared portion; the raw per-number
    // values stay visible in the Journal.
    const calls = this.coupleCalls?.get(train.number) ?? train.calls;
    const view = calls === train.calls ? train : { ...train, calls };
    return {
      ...view,
      // Headline figure: what is still ahead, reconciled across a coupled set.
      delay: rec?.delay ?? currentDelay(view, now),
      ownDelay: own,
      worstDelay: train.maxDelay,
      serviceLabel: meta.label,
      family: meta.family,
      position: this.couplePos?.get(train.number) ?? positionOf(view, now, this.rail),
      next: nextCall(view, now),
      trend: this.trend(train.number),
      history: this.history.get(train.number) ?? [],
      coupledWith: this.coupled?.get(train.number) ?? [],
      reconciled: this.coupleDelay?.get(train.number) ?? null,
    };
  }

  list({ family, minDelay = 0, running = false, q = '' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    let out = this.trains.map((t) => this.decorate(t, now));
    if (family) out = out.filter((t) => t.family === family);
    if (minDelay) out = out.filter((t) => t.delay >= minDelay);
    if (running) out = out.filter((t) => ['between', 'at_station'].includes(t.position.basis));
    if (q) {
      const s = q.toLowerCase();
      out = out.filter((t) =>
        t.number.includes(s) ||
        t.origin.toLowerCase().includes(s) ||
        t.destination.toLowerCase().includes(s) ||
        t.calls.some((c) => c.name.toLowerCase().includes(s)));
    }
    return out;
  }

  find(number) {
    const now = Math.floor(Date.now() / 1000);
    return (this.byNumber.get(String(number)) ?? []).map((t) => this.decorate(t, now));
  }

  /**
   * Full journey as drawable geometry: the track-following polyline for every
   * leg, plus the stops. Lets the map show one train's own route rather than
   * the whole network.
   */
  journeyGeo(train) {
    const coords = [];
    let covered = 0, total = 0;
    for (let i = 0; i < train.calls.length - 1; i++) {
      const a = train.calls[i], b = train.calls[i + 1];
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
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: {
            name: c.name, time: c.time, delay: c.delay, index: i,
            terminus: i === train.calls.length - 1 ? 1 : 0,
          },
        })),
      ],
    };
  }

  /** Departure board for a station (UIC group), from live data only. */
  board(uic, { limit = 30 } = {}) {
    const station = this.statics.stations.get(String(uic));
    if (!station) return null;
    const ids = new Set(station.stopIds);
    const now = Math.floor(Date.now() / 1000);
    const rows = [];
    for (const t of this.trains) {
      const idx = t.calls.findIndex((c) => ids.has(c.stopId));
      if (idx === -1) continue;
      const call = t.calls[idx];
      if (call.time < now - 600) continue;
      const d = this.decorate(t, now);
      rows.push({
        number: t.number,
        serviceLabel: d.serviceLabel,
        family: d.family,
        destination: t.destination,
        origin: t.origin,
        time: call.time,
        planned: call.time - call.delay,
        delay: call.delay,
        cancelled: t.cancelled,
        skipped: call.skipped,
        trend: d.trend,
        isTerminus: idx === t.calls.length - 1,
      });
    }
    rows.sort((a, b) => a.time - b.time);
    return { station, departures: rows.slice(0, limit) };
  }

  /**
   * Autocomplete over live trains: by number, by origin/destination, or by any
   * station served. Ranked so an exact number match comes first, then trains
   * that are actually moving.
   */
  suggest(q, { family, limit = 20 } = {}) {
    const s = (q ?? '').trim().toLowerCase();
    if (s.length < 1) return [];
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (const t of this.trains) {
      const meta = SERVICE_LABELS[t.service] ?? { label: t.service ?? 'Train', family: 'other' };
      if (family && family !== 'all' && meta.family !== family) continue;

      let score = -1, why = '';
      if (t.number === s) { score = 100; why = 'numéro'; }
      else if (t.number.startsWith(s)) { score = 90; why = 'numéro'; }
      else if (t.number.includes(s)) { score = 70; why = 'numéro'; }
      else if (t.destination.toLowerCase().startsWith(s)) { score = 60; why = 'destination'; }
      else if (t.origin.toLowerCase().startsWith(s)) { score = 55; why = 'origine'; }
      else if (t.destination.toLowerCase().includes(s)) { score = 45; why = 'destination'; }
      else if (t.origin.toLowerCase().includes(s)) { score = 40; why = 'origine'; }
      else {
        const stop = t.calls.find((c) => c.name.toLowerCase().includes(s));
        if (stop) { score = 30; why = `dessert ${stop.name}`; }
      }
      if (score < 0) continue;

      const pos = positionOf(t, now, this.rail);
      if (pos.basis === 'between' || pos.basis === 'at_station') score += 5;
      const next = nextCall(t, now);
      out.push({
        number: t.number,
        serviceLabel: meta.label,
        family: meta.family,
        origin: t.origin,
        destination: t.destination,
        delay: currentDelay(t, now),
        cancelled: t.cancelled,
        basis: pos.basis,
        coupledWith: this.coupled?.get(t.number) ?? [],
        next: next ? { name: next.name, time: next.time, delay: next.delay } : null,
        why,
        score,
      });
    }
    out.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
    // One row per physical train: hide the coupled twin behind the first.
    const seen = new Set();
    const merged = [];
    for (const r of out) {
      if (seen.has(r.number)) continue;
      for (const n of r.coupledWith) seen.add(n);
      merged.push(r);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  /** Station search over grouped stations; live-served ones first. */
  stations(q, limit = 12) {
    const s = (q ?? '').trim().toLowerCase();
    if (s.length < 2) return [];
    const served = new Set();
    for (const t of this.trains) for (const c of t.calls) served.add(c.stopId);
    const out = [];
    for (const st of this.statics.stations.values()) {
      if (!st.name.toLowerCase().includes(s)) continue;
      out.push({
        uic: st.uic, name: st.name, lat: st.lat, lon: st.lon,
        live: st.stopIds.some((id) => served.has(id)),
      });
    }
    out.sort((a, b) =>
      (b.live - a.live) ||
      (a.name.toLowerCase().indexOf(s) - b.name.toLowerCase().indexOf(s)) ||
      a.name.length - b.name.length);
    return out.slice(0, limit);
  }

  stats() {
    const now = Math.floor(Date.now() / 1000);
    const fam = {};
    let delayed = 0, cancelled = 0;
    for (const t of this.trains) {
      const f = (SERVICE_LABELS[t.service] ?? {}).family ?? 'other';
      fam[f] = (fam[f] ?? 0) + 1;
      if (currentDelay(t, now) >= 300) delayed++;
      if (t.cancelled) cancelled++;
    }
    return {
      total: this.trains.length,
      byFamily: fam,
      delayed,
      cancelled,
      feedTs: this.feedTs,
      fetchedAt: this.fetchedAt,
      ageSec: this.feedTs ? now - this.feedTs : null,
      stale: Boolean(this.fromSnapshot),
      replay: Boolean(this.replay),
      error: this.error,
    };
  }
}
