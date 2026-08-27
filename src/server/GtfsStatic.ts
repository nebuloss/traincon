/**
 * Static SNCF GTFS reference data.
 *
 * Only stops (names + coordinates), trips (train number -> service type) and
 * routes (line names) are loaded. stop_times.txt is 61 MB and deliberately
 * skipped: the GTFS-RT feed already carries the full stop list for every
 * running train.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Family } from '../shared/types.ts';

const exec = promisify(execFile);

const GTFS_URL =
  'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
const WANTED = ['stops.txt', 'trips.txt', 'routes.txt'] as const;
const MAX_AGE_MS = 12 * 3600 * 1000;

export interface ServiceMeta {
  label: string;
  family: Family;
}

/** Service markers embedded in the static trip_id, e.g. "...F:OUI:FR:Line::..." */
export const SERVICE_LABELS: Readonly<Record<string, ServiceMeta>> = {
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

export function serviceMeta(code: string | null): ServiceMeta {
  return (code && SERVICE_LABELS[code]) || { label: code ?? 'Train', family: 'other' };
}

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  uic: string | null;
}

/** A physical station: several stop_ids sharing one UIC code. */
export interface Station {
  uic: string;
  name: string;
  lat: number;
  lon: number;
  stopIds: string[];
}

export interface TrainMeta {
  number: string;
  service: string;
  line: string;
}

/** Minimal CSV reader: the SNCF feed quotes fields containing commas. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift()!.map((h) => h.trim());
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => {
        o[h] = r[i]!;
      });
      return o;
    });
}

export class GtfsStatic {
  private constructor(
    readonly stops: ReadonlyMap<string, Stop>,
    readonly stations: ReadonlyMap<string, Station>,
    readonly trains: ReadonlyMap<string, TrainMeta>,
    readonly loadedAt: number,
  ) {}

  /** Older than the refresh window, so worth reloading. */
  get isStale(): boolean {
    return Date.now() - this.loadedAt > MAX_AGE_MS;
  }

  private static async isFresh(file: string): Promise<boolean> {
    try {
      const s = await stat(file);
      return Date.now() - s.mtimeMs < MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private static async download(dir: string): Promise<string> {
    const zip = path.join(dir, 'gtfs.zip');
    if (await GtfsStatic.isFresh(zip)) return zip;
    const res = await fetch(GTFS_URL);
    if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));
    return zip;
  }

  /** Download + parse the static GTFS into in-memory lookup tables. */
  static async load(dataDir = 'data'): Promise<GtfsStatic> {
    await mkdir(dataDir, { recursive: true });
    const zip = await GtfsStatic.download(dataDir);
    await exec('unzip', ['-o', '-q', zip, ...WANTED, '-d', dataDir]);

    const [stopRows, tripRows, routeRows] = await Promise.all(
      WANTED.map(async (f) => parseCsv(await readFile(path.join(dataDir, f), 'utf8'))),
    );

    // A single physical station appears under several stop_ids: one StopArea
    // plus one StopPoint per service ("OCETGV INOUI-87673202", "OCEOUIGO-…").
    // They share the trailing UIC code, which is what we group on — otherwise a
    // departure board only ever shows one operator's trains.
    const stops = new Map<string, Stop>();
    const stations = new Map<string, Station>();
    const uicOf = (id: string): string | null => /-?(\d{7,8})$/.exec(id)?.[1] ?? null;

    for (const s of stopRows!) {
      const lat = parseFloat(s['stop_lat']!);
      const lon = parseFloat(s['stop_lon']!);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const id = s['stop_id']!;
      const uic = uicOf(id);
      stops.set(id, { id, name: s['stop_name']!, lat, lon, uic });
      if (!uic) continue;
      let st = stations.get(uic);
      if (!st) {
        st = { uic, name: s['stop_name']!, lat, lon, stopIds: [] };
        stations.set(uic, st);
      }
      st.stopIds.push(id);
      // Prefer the StopArea's own name and coordinates as canonical.
      if (id.startsWith('StopArea:')) {
        st.name = s['stop_name']!;
        st.lat = lat;
        st.lon = lon;
      }
    }

    const routes = new Map(routeRows!.map((r) => [r['route_id']!, r]));

    // Train number -> service marker and line name. A number is reused across
    // dates, so first match wins; the marker is stable.
    const trains = new Map<string, TrainMeta>();
    const idRe = /^OCE([A-Z]{2})(\d+)F/;
    const svcRe = /F:([A-Z]+):/;
    for (const t of tripRows!) {
      const tripId = t['trip_id']!;
      const m = idRe.exec(tripId);
      const sv = svcRe.exec(tripId);
      if (!m || !sv) continue;
      const key = `${m[1]}${m[2]}`;
      if (trains.has(key)) continue;
      trains.set(key, {
        number: m[2]!,
        service: sv[1]!,
        line: routes.get(t['route_id']!)?.['route_long_name'] ?? '',
      });
    }

    // Free the extracted text files; the maps are what we keep.
    await Promise.all(WANTED.map((f) => rm(path.join(dataDir, f), { force: true })));
    return new GtfsStatic(stops, stations, trains, Date.now());
  }

  findStation(uic: string): Station | undefined {
    return this.stations.get(uic);
  }

  /** Search stations by name; `servedIds` promotes those currently served. */
  searchStations(query: string, servedIds: ReadonlySet<string>, limit = 12): Station[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Station[] = [];
    for (const st of this.stations.values()) {
      if (st.name.toLowerCase().includes(q)) out.push(st);
    }
    const isLive = (s: Station): number => (s.stopIds.some((i) => servedIds.has(i)) ? 1 : 0);
    out.sort(
      (a, b) =>
        isLive(b) - isLive(a) ||
        a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q) ||
        a.name.length - b.name.length,
    );
    return out.slice(0, limit);
  }
}
