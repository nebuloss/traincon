#!/usr/bin/env node
/**
 * French railway signalling, fetched once and written as a compact index.
 *
 * Source: the `signalisation` vector layer served by Carto Tchoo
 * (https://carto.tchoo.net, by Nicolas Wurtz), built from SNCF Réseau public
 * data — every object carries its Gaïa identifier. It is referenced as a
 * réutilisation on data.gouv.fr.
 *
 * Why this rather than the alternatives:
 *
 *   - SNCF's own portal publishes no signal positions. The dataset named
 *     "images des feux de circulation ferroviaire" is a computer-vision
 *     corpus — bounding boxes in camera frames, no coordinates.
 *   - OpenStreetMap has about 4 800 typed French signals, of which 1 900 carry
 *     the franchissable/non-franchissable plate. On the Bordeaux–Dax corridor
 *     that is 177 signals and no plates at all.
 *   - This layer gives 1 475 objects on that same corridor, and `type_if`
 *     distinguishes CARRE from S directly — a carré is non-franchissable and a
 *     sémaphore is franchissable, so the distinction comes for free.
 *
 * The tiles carry identical contents at every zoom, so the whole country is
 * ~90 tiles at zoom 8 rather than seventeen thousand at zoom 12. Fetched
 * slowly, once, and cached in data/geo — this is somebody's personal server.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.SIGNALS_TILES ?? 'https://tiles.tchoo.net/signalisation';
const ZOOM = 8;
/** Metropolitan France, from the layer's own declared bounds. */
const BOUNDS = { west: -4.9, south: 42.2, east: 8.4, north: 51.2 };
/** Courtesy delay between requests, milliseconds. */
const PAUSE_MS = Number(process.env.SIGNALS_PAUSE ?? 250);

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

// ── a minimal vector-tile reader ─────────────────────────────────────────────
//
// Only what is needed for a layer of points: varints, length-delimited fields,
// and MoveTo geometry. Written out rather than pulled in, to keep the server's
// install footprint to the protobuf decoding the feed already needs.

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  varint() {
    let shift = 0;
    let val = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      val += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return val;
      shift += 7;
    }
  }

  /** Iterate (fieldNumber, wireType), leaving `pos` on the value. */
  *fields() {
    while (this.pos < this.end) {
      const key = this.varint();
      yield [key >> 3, key & 7];
    }
  }

  /**
   * Skip the value of a field of the given wire type.
   *
   * The length is read into a local first. `this.pos += this.varint()` reads
   * the left operand before evaluating the right, so it would add the length
   * to the position *before* the varint's own bytes were consumed — leaving
   * the cursor short by one or two and desyncing everything after it.
   */
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    } else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
    else throw new Error(`wire type ${wire}`);
  }

  /** A length-delimited field, as its own reader. */
  sub() {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  string() {
    const len = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  packed() {
    const len = this.varint();
    const end = this.pos + len;
    const out = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
}

function readValue(r) {
  for (const [fn, wire] of r.fields()) {
    if (fn === 1) return r.string();
    if (fn === 2) {
      const v = r.buf.readFloatLE(r.pos);
      r.pos += 4;
      return v;
    }
    if (fn === 3) {
      const v = r.buf.readDoubleLE(r.pos);
      r.pos += 8;
      return v;
    }
    if (fn === 4 || fn === 5) return r.varint();
    if (fn === 6) {
      const v = r.varint();
      return (v >> 1) ^ -(v & 1);
    }
    if (fn === 7) return Boolean(r.varint());
    r.skip(wire);
  }
  return null;
}

/** Points and their attributes from one tile. */
export function decodeTile(buf, z, x, y) {
  const out = [];
  const tile = new Reader(buf);

  for (const [fn, wire] of tile.fields()) {
    if (fn !== 3) {
      tile.skip(wire);
      continue;
    }
    const layer = tile.sub();
    const keys = [];
    const values = [];
    const features = [];
    let extent = 4096;

    for (const [lf, lw] of layer.fields()) {
      if (lf === 3) keys.push(layer.string());
      else if (lf === 4) values.push(readValue(layer.sub()));
      else if (lf === 5) extent = layer.varint();
      else if (lf === 2) features.push(layer.sub());
      else layer.skip(lw);
    }

    for (const f of features) {
      let tags = [];
      let geom = [];
      let type = 0;
      for (const [ff, fw] of f.fields()) {
        if (ff === 2) tags = f.packed();
        else if (ff === 3) type = f.varint();
        else if (ff === 4) geom = f.packed();
        else f.skip(fw);
      }
      if (type !== 1 || geom.length < 3) continue;

      const dx = (geom[1] >> 1) ^ -(geom[1] & 1);
      const dy = (geom[2] >> 1) ^ -(geom[2] & 1);
      const n = 2 ** z;
      const lon = ((x + dx / extent) / n) * 360 - 180;
      const lat =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + dy / extent)) / n))) * 180) / Math.PI;

      const attrs = {};
      for (let i = 0; i + 1 < tags.length; i += 2) {
        const k = keys[tags[i]];
        if (k !== undefined) attrs[k] = values[tags[i + 1]];
      }
      out.push({ lat, lon, attrs });
    }
  }
  return out;
}

async function tile(z, x, y) {
  const res = await fetch(`${BASE}/${z}/${x}/${y}.pbf`, {
    headers: { 'user-agent': 'traincon/1.0 (+https://github.com/nebuloss/traincon)' },
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${z}/${x}/${y}`);

  let buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return null;
  // Some servers hand back gzip regardless of what fetch negotiated.
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = path.join(process.cwd(), 'data', 'geo');
  await mkdir(dir, { recursive: true });

  const x0 = lonToX(BOUNDS.west, ZOOM);
  const x1 = lonToX(BOUNDS.east, ZOOM);
  const y0 = latToY(BOUNDS.north, ZOOM);
  const y1 = latToY(BOUNDS.south, ZOOM);
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);

  process.stdout.write(`signalisation : ${total} tuiles au zoom ${ZOOM}\n`);

  const seen = new Map();
  let done = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      done++;
      let buf = null;
      try {
        buf = await tile(ZOOM, x, y);
      } catch (e) {
        process.stdout.write(`  ${x}/${y} : ${e.message}\n`);
      }
      if (buf) {
        for (const { lat, lon, attrs } of decodeTile(buf, ZOOM, x, y)) {
          const id = attrs.idgaia ?? `${lat.toFixed(6)},${lon.toFixed(6)}`;
          if (seen.has(id)) continue;
          seen.set(id, {
            // Six decimals is about 10 cm — far finer than anything here needs.
            lat: Math.round(lat * 1e6) / 1e6,
            lon: Math.round(lon * 1e6) / 1e6,
            type: attrs.type_if ?? null,
            line: attrs.code_ligne != null ? String(attrs.code_ligne) : null,
            pk: attrs.pk ?? null,
            sens: attrs.sens ?? null,
          });
        }
      }
      if (done % 10 === 0) process.stdout.write(`  ${done}/${total} — ${seen.size} objets\n`);
      await sleep(PAUSE_MS);
    }
  }

  const rows = [...seen.values()];
  const byType = {};
  for (const r of rows) byType[r.type ?? '?'] = (byType[r.type ?? '?'] ?? 0) + 1;

  const file = path.join(dir, 'signals.json');
  await writeFile(file, JSON.stringify({ source: BASE, zoom: ZOOM, count: rows.length, rows }));
  process.stdout.write(`\n${rows.length} objets -> ${file}\n`);
  process.stdout.write(
    `types : ${Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${e.stack}\n`);
    process.exit(1);
  });
}
