// GTFS-RT trip updates for the SNCF network (TGV / Intercités / TER).
// Keyless, public, refreshed every ~2 min, forecasting ~8 h ahead.
import pkg from 'gtfs-realtime-bindings';
import { readFile } from 'node:fs/promises';

const { transit_realtime: rtb } = pkg;
const RT_URL = process.env.SNCF_FEED_URL ||
  'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';

// Replay a captured feed instead of calling upstream. Set SNCF_FEED_FILE to a
// .pb capture; development and tests then work with the proxy down, offline,
// or when you need a fixed scenario to reproduce a bug.
const FEED_FILE = process.env.SNCF_FEED_FILE || null;
// 'auto' rebases every timestamp so the capture's own clock maps onto now,
// which is what makes an old capture behave like a live feed rather than a
// train set that has already finished running.
const FEED_SHIFT = process.env.SNCF_FEED_SHIFT ?? 'auto';
// Last resort when the live feed is down and there is no cached snapshot:
// serve a capture rather than an empty network. Always reported as replay so
// the page can label it — demo data must never masquerade as live.
const FEED_FALLBACK = process.env.SNCF_FEED_FALLBACK || null;

const ID_RE = /^OCE([A-Z]{2})(\d+)F/;
const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Initial bearing a -> b, degrees clockwise from north. */
function bearing(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at fraction f (0..1) along the great circle a -> b. */
function greatCircle(a, b, f) {
  const d = haversine(a, b) / EARTH_KM;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y =
    A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
  return {
    lat: deg(Math.atan2(z, Math.hypot(x, y))),
    lon: deg(Math.atan2(y, x)),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch and decode the raw protobuf feed.
 *
 * The proxy resets TLS connections often enough that a single attempt is not
 * good enough to boot on: retry with backoff, and give the request a deadline
 * so a hung socket cannot stall the poll loop.
 */
export async function fetchFeed({ attempts = 3, timeoutMs = 20_000, allowFallback = true } = {}) {
  if (FEED_FILE) {
    const buf = await readFile(FEED_FILE);
    const msg = rtb.FeedMessage.decode(new Uint8Array(buf));
    msg._replay = true;
    return msg;
  }
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(RT_URL, {
        headers: { 'accept-encoding': 'gzip' },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`GTFS-RT fetch failed: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return rtb.FeedMessage.decode(buf);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  if (FEED_FALLBACK && allowFallback) {
    try {
      const buf = await readFile(FEED_FALLBACK);
      const msg = rtb.FeedMessage.decode(new Uint8Array(buf));
      msg._replay = true;
      return msg;
    } catch { /* fall through to the real error */ }
  }
  throw new Error(`GTFS-RT indisponible après ${attempts} tentatives : ${lastErr?.message ?? lastErr}`);
}

const num = (v) => (typeof v === 'object' && v !== null ? v.toNumber() : v);

/**
 * Turn one trip_update into a normalised train object.
 * Every time here is SNCF's own live forecast — not interpolated.
 */
function buildTrain(entity, statics, feedTs, shift = 0) {
  const m = ID_RE.exec(entity.id);
  if (!m) return null;
  const tu = entity.tripUpdate;
  if (!tu?.stopTimeUpdate?.length) return null;

  const key = `${m[1]}${m[2]}`;
  const meta = statics.trains.get(key);
  const cancelled = tu.trip?.scheduleRelationship === 3; // CANCELED

  const calls = [];
  for (const stu of tu.stopTimeUpdate) {
    const stop = statics.stops.get(stu.stopId);
    if (!stop) continue;
    const arr = stu.arrival, dep = stu.departure;
    const rawAt = num(dep?.time) || num(arr?.time) || null;
    if (!rawAt) continue;
    const at = rawAt + shift;
    const delay = num(dep?.delay) ?? num(arr?.delay) ?? 0;
    calls.push({
      stopId: stu.stopId,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      arrival: num(arr?.time) ? num(arr.time) + shift : null,
      departure: num(dep?.time) ? num(dep.time) + shift : null,
      time: at,
      delay,
      skipped: stu.scheduleRelationship === 1, // SKIPPED
    });
  }
  if (calls.length < 2) return null;
  calls.sort((a, b) => a.time - b.time);

  const delays = calls.map((c) => c.delay);
  const maxDelay = Math.max(...delays);
  const lastDelay = calls[calls.length - 1].delay;

  return {
    id: entity.id,
    number: m[2],
    service: meta?.service ?? null,
    line: meta?.line ?? '',
    origin: calls[0].name,
    destination: calls[calls.length - 1].name,
    calls,
    cancelled,
    maxDelay,
    lastDelay,
    feedTs,
  };
}

/**
 * Which leg of the journey is the train on right now?
 * Pure timetable logic, no geometry: returns the two calls it sits between
 * and how far along it is. Every time used here is SNCF's own live forecast.
 */
export function legAt(train, now = Math.floor(Date.now() / 1000)) {
  const calls = train.calls;
  const first = calls[0], last = calls[calls.length - 1];

  if (now < first.time) return { basis: 'not_departed', a: first, b: calls[1] ?? first, f: 0, i: 0 };
  if (now >= last.time) return { basis: 'arrived', a: calls[calls.length - 2] ?? last, b: last, f: 1, i: calls.length - 2 };

  for (let i = 0; i < calls.length - 1; i++) {
    const a = calls[i], b = calls[i + 1];
    const depA = a.departure ?? a.time;
    if (a.arrival && now >= a.arrival && now < depA) {
      return { basis: 'at_station', a, b, f: 0, i, dwell: true };
    }
    const arrB = b.arrival ?? b.time;
    if (now >= depA && now < arrB) {
      const span = arrB - depA;
      return { basis: 'between', a, b, f: span > 0 ? (now - depA) / span : 0, i, span };
    }
  }
  return { basis: 'unknown', a: last, b: last, f: 1, i: calls.length - 2 };
}

/**
 * Where is the train right now?
 *
 * SNCF publishes no GPS, so this is derived from its own live stop forecast.
 * With a RailGraph the point is projected onto real track and the bearing
 * follows the actual curve; without one it falls back to a great circle.
 *
 * `quality` says plainly what the number is worth — never claim more.
 */
/**
 * How much ground truth is behind the current estimate.
 *
 * GTFS-RT only revises a train when it is observed, which in practice means
 * when it calls at a stop. On a leg with no intermediate stop the published
 * delay is simply carried forward — so a train that recovers (or loses) time
 * mid-leg is invisible until it arrives. The estimate is only as good as the
 * time since the last confirmed call, and the UI must be able to say so.
 */
export function observation(train, now = Math.floor(Date.now() / 1000)) {
  const passed = train.calls.filter((c) => c.time <= now);
  const last = passed[passed.length - 1] ?? null;
  const next = train.calls.find((c) => c.time > now) ?? null;
  if (!last) {
    return { lastStop: null, ageSec: null, legSec: null, confidence: 'scheduled' };
  }
  const ageSec = now - last.time;
  const legSec = next ? next.time - last.time : null;
  // Long unobserved legs are where the published time drifts furthest from
  // reality; short hops re-anchor every few minutes.
  let confidence;
  if (ageSec < 120) confidence = 'confirmed';
  else if (ageSec < 20 * 60) confidence = 'good';
  else if (ageSec < 45 * 60) confidence = 'estimated';
  else confidence = 'stale';
  return { lastStop: last.name, lastStopTime: last.time, ageSec, legSec, confidence };
}

export function positionOf(train, now = Math.floor(Date.now() / 1000), graph = null) {
  const leg = legAt(train, now);
  const { a, b, f, basis } = leg;
  const calls = train.calls;
  const progress = (leg.i + (basis === 'between' ? f : 0)) / Math.max(1, calls.length - 1);
  const obs = observation(train, now);

  const base = {
    basis,
    progress,
    fromStop: basis === 'between' ? a.name : undefined,
    atStation: basis === 'between' ? undefined : (basis === 'arrived' ? b.name : a.name),
    nextStop: basis === 'arrived' ? null : b.name,
    legProgress: basis === 'between' ? f : undefined,
  };

  // Try real track geometry first.
  const railPath = graph ? graph.path(a.lat, a.lon, b.lat, b.lon) : null;
  if (railPath) {
    const pt = graph.constructor.at(railPath, basis === 'arrived' ? 1 : f);
    const span = leg.span ?? 0;
    const legHours = span / 3600;

    // The line-speed profile gives the *shape* of the run; the timetable gives
    // its duration. Scaling one onto the other turns a nominal line speed into
    // the speed this train is actually managing.
    let speedKmh = 0;
    if (basis === 'between' && legHours > 0) {
      const nominal = pt.nominalHours;
      if (nominal > 0 && pt.lineKmh != null) {
        speedKmh = Math.round(pt.lineKmh * (nominal / legHours));
      } else {
        speedKmh = Math.round(railPath.total / legHours);
      }
    }
    const avgKmh = legHours > 0 ? Math.round(railPath.total / legHours) : 0;

    return {
      ...base,
      lat: pt.lat, lon: pt.lon, bearing: pt.bearing,
      legKm: Math.round(railPath.total * 10) / 10,
      distKm: Math.round(pt.distKm * 10) / 10,
      speedKmh,
      avgKmh,
      lineKmh: pt.lineKmh,
      geometry: 'rail',
      observation: obs,
      quality: {
        method: 'rail_graph_speed_profile',
        confidence: obs.confidence,
        note: 'projeté sur la voie avec le profil de vitesse de ligne ; horaire SNCF temps réel, position non mesurée',
      },
    };
  }

  // Fall back to a great circle between the two stations.
  const pt = basis === 'arrived' ? { lat: b.lat, lon: b.lon }
    : basis === 'between' ? greatCircle(a, b, f)
    : { lat: a.lat, lon: a.lon };
  const legKm = haversine(a, b);
  const span = leg.span ?? 0;
  return {
    ...base,
    lat: pt.lat, lon: pt.lon, bearing: bearing(a, b),
    legKm: Math.round(legKm),
    speedKmh: basis === 'between' && span > 0 ? Math.round((legKm / span) * 3600) : 0,
    geometry: 'direct',
    observation: obs,
    quality: {
      method: 'great_circle',
      confidence: obs.confidence,
      note: 'pas de géométrie de voie pour ce tronçon ; ligne droite entre gares',
    },
  };
}

/** The next call the train has yet to make. */
export function nextCall(train, now = Math.floor(Date.now() / 1000)) {
  return train.calls.find((c) => c.time > now) ?? null;
}

/**
 * The delay that actually matters: the one still ahead of you.
 *
 * `maxDelay` is the worst figure anywhere on the journey, including stops
 * already behind the train — so a service that lost 70 min early on and has
 * since clawed back 20 still reads "+70". That is what made this app show +70
 * for 8582 while SNCF Connect showed +50: by Bordeaux the train really was
 * only 50 late. Take the delay at the next call, falling back to the terminus.
 */
export function currentDelay(train, now = Math.floor(Date.now() / 1000)) {
  const next = train.calls.find((c) => c.time > now);
  return (next ?? train.calls[train.calls.length - 1]).delay;
}

/** Decode the feed into normalised trains, keyed by train number. */
export async function loadTrains(statics) {
  const feed = await fetchFeed();
  const rawTs = num(feed.header.timestamp);
  const replaying = Boolean(feed._replay);

  let shift = 0;
  if (replaying && FEED_SHIFT !== 'none') {
    shift = FEED_SHIFT === 'auto'
      ? Math.floor(Date.now() / 1000) - rawTs
      : Number(FEED_SHIFT) || 0;
  }
  const feedTs = rawTs + shift;

  const trains = [];
  for (const e of feed.entity) {
    const t = buildTrain(e, statics, feedTs, shift);
    if (t) trains.push(t);
  }
  return { trains, feedTs, replay: replaying, shift };
}
