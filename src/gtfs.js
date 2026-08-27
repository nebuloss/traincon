// Static SNCF GTFS reference data.
// We only need stops (names + coords), trips (train number -> service type) and
// routes (line names). stop_times.txt is 61 MB and deliberately skipped: the
// GTFS-RT feed already carries the full stop list for every running train.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const exec = promisify(execFile);

const GTFS_URL =
  'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
const WANTED = ['stops.txt', 'trips.txt', 'routes.txt'];
const MAX_AGE_MS = 12 * 3600 * 1000;

// Service markers embedded in the static trip_id, e.g. "...F:OUI:FR:Line::..."
export const SERVICE_LABELS = {
  OUI: { label: 'TGV inOUI', family: 'tgv' },
  OGO: { label: 'OUIGO', family: 'tgv' },
  LYR: { label: 'TGV Lyria', family: 'tgv' },
  ICE: { label: 'ICE', family: 'tgv' },
  TT: { label: 'TGV', family: 'tgv' },
  IC: { label: 'Intercités', family: 'ic' },
  ICN: { label: 'Intercités de Nuit', family: 'ic' },
  TER: { label: 'TER', family: 'ter' },
  TRN: { label: 'Train', family: 'other' },
  NAV: { label: 'Navette', family: 'other' },
};

// Minimal CSV reader: the SNCF feed quotes fields containing commas.
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length === header.length).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

async function isFresh(file) {
  try {
    const s = await stat(file);
    return Date.now() - s.mtimeMs < MAX_AGE_MS;
  } catch { return false; }
}

async function download(dir) {
  const zip = path.join(dir, 'gtfs.zip');
  if (await isFresh(zip)) return zip;
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  return zip;
}

/** Download + parse the static GTFS into in-memory lookup tables. */
export async function loadStatic(dataDir = 'data') {
  await mkdir(dataDir, { recursive: true });
  const zip = await download(dataDir);
  await exec('unzip', ['-o', '-q', zip, ...WANTED, '-d', dataDir]);

  const [stopRows, tripRows, routeRows] = await Promise.all(
    WANTED.map(async (f) => parseCsv(await readFile(path.join(dataDir, f), 'utf8')))
  );

  // A single physical station appears under several stop_ids: one StopArea plus
  // one StopPoint per service ("OCETGV INOUI-87673202", "OCEOUIGO-87673202"...).
  // They share the trailing UIC code, which is what we group on -- otherwise a
  // departure board only ever shows one operator's trains.
  const stops = new Map();
  const stations = new Map(); // uic -> { uic, name, lat, lon, stopIds[] }
  const uicOf = (id) => (/-?(\d{7,8})$/.exec(id) ?? [])[1] ?? null;

  for (const s of stopRows) {
    const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const uic = uicOf(s.stop_id);
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lon, uic });
    if (!uic) continue;
    let st = stations.get(uic);
    if (!st) {
      st = { uic, name: s.stop_name, lat, lon, stopIds: [] };
      stations.set(uic, st);
    }
    st.stopIds.push(s.stop_id);
    // Prefer the StopArea's own name/coords as the canonical ones.
    if (s.stop_id.startsWith('StopArea:')) {
      st.name = s.stop_name; st.lat = lat; st.lon = lon;
    }
  }

  const routes = new Map(routeRows.map((r) => [r.route_id, r]));

  // Train number -> { service marker, route long name }.
  // A number is reused across dates, so first match wins; the marker is stable.
  const trains = new Map();
  const idRe = /^OCE([A-Z]{2})(\d+)F/;
  const svcRe = /F:([A-Z]+):/;
  for (const t of tripRows) {
    const m = idRe.exec(t.trip_id);
    const sv = svcRe.exec(t.trip_id);
    if (!m || !sv) continue;
    const key = `${m[1]}${m[2]}`;
    if (trains.has(key)) continue;
    trains.set(key, {
      number: m[2],
      service: sv[1],
      line: routes.get(t.route_id)?.route_long_name || '',
    });
  }

  // Free the extracted text files; the maps are what we keep.
  await Promise.all(WANTED.map((f) => rm(path.join(dataDir, f), { force: true })));
  return { stops, stations, trains, loadedAt: Date.now() };
}
