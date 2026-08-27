#!/usr/bin/env node
// Onboard TGV tracker — reads the REAL GPS from the train's own WiFi portal.
//
// This is the only source of true SNCF train GPS. It is undocumented and only
// reachable while connected to the train's WiFi (_SNCF_WIFI_INOUI / OUIFI).
// Nothing here needs an API key.
//
//   node src/onboard.mjs            # live dashboard, refreshes every 3 s
//   node src/onboard.mjs --once     # single reading
//   node src/onboard.mjs --json     # raw JSON, for piping
//
// Endpoints (all GET, JSON):
//   /router/api/train/gps       latitude, longitude, altitude, speed (m/s), heading, fix
//   /router/api/train/details   train number, carrier, stops[] with progress
//   /router/api/connection/statistics   wifi quality, connected devices
//   /router/api/bar/attendance  isBarQueueEmpty

const BASE = process.env.SNCF_WIFI_BASE ?? 'https://wifi.sncf';
const ONCE = process.argv.includes('--once');
const JSON_OUT = process.argv.includes('--json');
const PERIOD_MS = 3000;

async function get(path, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { _error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { _error: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

const kmh = (mps) => (typeof mps === 'number' ? Math.round(mps * 3.6) : null);
const compass = (deg) => {
  if (typeof deg !== 'number') return '?';
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];
};

function bar(pct, width = 28) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

async function snapshot() {
  const [gps, details] = await Promise.all([
    get('/router/api/train/gps'),
    get('/router/api/train/details'),
  ]);
  return { gps, details, at: new Date() };
}

function renderText({ gps, details, at }) {
  const L = [];
  L.push(`\x1b[1mTGV onboard — ${at.toLocaleTimeString('fr-FR')}\x1b[0m`);
  L.push('─'.repeat(46));

  if (gps._error) {
    L.push(`\x1b[31mGPS indisponible : ${gps._error}\x1b[0m`);
    L.push('');
    L.push('Vérifiez que vous êtes connecté au WiFi du train');
    L.push('(_SNCF_WIFI_INOUI ou OUIFI) et que le portail est ouvert.');
    return L.join('\n');
  }

  const speed = kmh(gps.speed);
  L.push(`Vitesse   : \x1b[1m${speed ?? '?'} km/h\x1b[0m`);
  L.push(`Position  : ${gps.latitude?.toFixed(5)}, ${gps.longitude?.toFixed(5)}`);
  L.push(`Cap       : ${Math.round(gps.heading ?? 0)}° (${compass(gps.heading)})`);
  if (gps.altitude != null) L.push(`Altitude  : ${Math.round(gps.altitude)} m`);
  if (gps.fix != null) L.push(`Fix GPS   : ${gps.fix}`);
  L.push(`Carte     : https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=12/${gps.latitude}/${gps.longitude}`);

  if (!details._error) {
    const num = details.number ?? details.trainNumber ?? details.trainId;
    if (num) L.push(`\nTrain     : ${num}${details.carrier ? ' · ' + details.carrier : ''}`);
    const stops = details.stops ?? details.stopsList ?? [];
    if (Array.isArray(stops) && stops.length) {
      L.push('');
      for (const s of stops) {
        const p = s.progress ?? {};
        const pct = p.progressPercentage ?? s.progressPercentage;
        const name = s.label ?? s.name ?? s.station ?? '?';
        const rem = p.remainingDistance ?? s.remainingDistance;
        const remTxt = typeof rem === 'number' ? `${Math.round(rem / 1000)} km` : '';
        L.push(typeof pct === 'number'
          ? `  ${name.slice(0, 22).padEnd(24)} ${bar(pct, 20)} ${String(Math.round(pct)).padStart(3)}%  ${remTxt}`
          : `  ${name.slice(0, 22).padEnd(24)} ${remTxt}`);
      }
    }
  }
  return L.join('\n');
}

async function main() {
  if (ONCE || JSON_OUT) {
    const snap = await snapshot();
    console.log(JSON_OUT ? JSON.stringify(snap, null, 2) : renderText(snap));
    return;
  }
  process.stdout.write('\x1b[?25l'); // hide cursor
  const stop = () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); };
  process.on('SIGINT', stop);
  for (;;) {
    const snap = await snapshot();
    process.stdout.write('\x1b[2J\x1b[H' + renderText(snap) + '\n\n(Ctrl-C pour quitter)\n');
    await new Promise((r) => setTimeout(r, PERIOD_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
