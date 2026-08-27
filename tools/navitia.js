// SNCF / Navitia API client (optional, key-gated).
//
// Why this exists: the public GTFS-RT export carries a delay forward until the
// train is next observed at a stop, so on a long leg it can be badly stale —
// measured at +70 min on 8540/Bordeaux when the truth was +55. Navitia ingests
// SNCF's real-time system directly rather than through that export, so its
// departure boards may be fresher. This lets us find out, and use it when it is.
//
// Free key: https://numerique.sncf.com/startup/api/token-developpeur/
// Auth is HTTP Basic with the token as username and an empty password.
//
//   SNCF_API_KEY=xxxx node src/compare-sources.mjs 8540

const BASE = process.env.SNCF_API_BASE || 'https://api.sncf.com/v1/coverage/sncf';
const KEY = process.env.SNCF_API_KEY || null;

export const hasKey = () => Boolean(KEY);

async function call(path, params = {}, { timeoutMs = 15_000 } = {}) {
  if (!KEY) throw new Error('SNCF_API_KEY absent — inscription sur numerique.sncf.com');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        // Basic auth, token as username, empty password.
        authorization: 'Basic ' + Buffer.from(KEY + ':').toString('base64'),
        accept: 'application/json',
      },
    });
    if (res.status === 401) throw new Error('clé refusée (401)');
    if (res.status === 429) throw new Error('quota dépassé (429) — 5 000 requêtes/jour');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** "20260827T164500" -> epoch seconds (Navitia local time, Europe/Paris). */
export function parseNavitiaTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const [, Y, Mo, D, h, mi, sec] = m.map(Number);
  // Navitia returns local time; derive the offset for that instant.
  const guess = Date.UTC(Y, Mo - 1, D, h, mi, sec) / 1000;
  const local = new Date(guess * 1000).toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  const offset = (guess * 1000 - new Date(local).getTime()) / 1000;
  return Math.round(guess + offset);
}

/**
 * Live departures for a stop area.
 * `base_departure_date_time` is the timetable, `departure_date_time` the
 * real-time estimate — their difference is Navitia's view of the delay.
 */
export async function departures(stopAreaId, { count = 20, from } = {}) {
  const j = await call(`/stop_areas/${encodeURIComponent(stopAreaId)}/departures`, {
    count,
    from_datetime: from,
    data_freshness: 'realtime',
  });
  return (j.departures ?? []).map((d) => {
    const st = d.stop_date_time ?? {};
    const real = parseNavitiaTime(st.departure_date_time);
    const base = parseNavitiaTime(st.base_departure_date_time);
    return {
      number: d.display_informations?.headsign ?? null,
      label: d.display_informations?.commercial_mode ?? null,
      direction: d.display_informations?.direction ?? null,
      departure: real,
      scheduled: base,
      delaySec: real != null && base != null ? real - base : null,
      status: d.display_informations?.description || null,
    };
  });
}

/** Today's real-time journey for one vehicle, if Navitia knows it. */
export async function vehicleJourney(trainNumber) {
  const j = await call('/vehicle_journeys', {
    'filter[]': `vehicle_journey.has_headsign(${trainNumber})`,
    data_freshness: 'realtime',
    count: 5,
  });
  return (j.vehicle_journeys ?? []).map((vj) => ({
    id: vj.id,
    name: vj.name,
    calls: (vj.stop_times ?? []).map((st) => ({
      name: st.stop_point?.name,
      arrival: parseNavitiaTime(st.arrival_time),
      departure: parseNavitiaTime(st.departure_time),
    })),
  }));
}

export async function ping() {
  const j = await call('/', {});
  return { ok: true, region: j.regions?.[0]?.id ?? 'sncf' };
}
