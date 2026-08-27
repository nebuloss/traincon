#!/usr/bin/env node
// Longitudinal comparator: TrainTracker24 tiles vs the raw SNCF GTFS-RT feed.
//
// Purpose: decide empirically whether TT24 has a position source we don't.
// If they only interpolate the same feed, their positions must be reproducible
// from it. Any train where they disagree with a *direct feed reading* is
// evidence of an extra source — or of a modelling artefact.
//
//   node src/compare.mjs                 # default tiles, 25 s cadence
//
// Output: data/compare.jsonl

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStatic } from './gtfs.js';
import { loadTrains, positionOf, haversine } from './realtime.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'compare.jsonl');
const PERIOD_MS = Number(process.env.PERIOD_MS ?? 25_000);

// z=10 tiles covering a spread of French rail: SW (Dax/Bordeaux), Paris,
// Rhone valley, Brittany. Keeps request volume modest and polite.
const TILES = (process.env.TILES ?? '10/509/373,10/508/366,10/518/357,10/523/369,10/499/364')
  .split(',').map((s) => s.trim());

const UA = 'sncf-tracker-research/1.0 (comparing open feed vs public tiles)';

async function fetchTile(t) {
  const url = `https://www.traintracker24.com/api/runtime/tile/${t}`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) return { tile: t, error: `HTTP ${r.status}` };
  const j = await r.json();
  return { tile: t, generatedAt: j.generatedAt, trains: j.trains ?? [], totals: j.totals };
}

const paris = (ts) =>
  new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' });

async function tick(statics) {
  const now = Math.floor(Date.now() / 1000);
  const [feed, tiles] = await Promise.all([
    loadTrains(statics),
    Promise.all(TILES.map((t) => fetchTile(t).catch((e) => ({ tile: t, error: String(e.message) })))),
  ]);

  const mine = new Map();
  for (const t of feed.trains) {
    const p = positionOf(t, now);
    // Keep the last one seen per number (duplicates are rare).
    mine.set(t.number, { t, p });
  }

  const rows = [];
  for (const tile of tiles) {
    if (tile.error) continue;
    for (const th of tile.trains) {
      const m = mine.get(th.number);
      if (!m) {
        rows.push({ t: now, number: th.number, tile: tile.tile, status: 'not_in_feed',
          theirLat: th.lat, theirLon: th.lon, theirDelay: th.delaySec,
          theirPrev: th.previousStopName, theirNext: th.nextStopName,
          theirAtStation: !!th.atStation, theirSpeed: th.speedMps,
          theirGeneratedAt: tile.generatedAt });
        continue;
      }
      const gap = haversine({ lat: th.lat, lon: th.lon }, { lat: m.p.lat, lon: m.p.lon });
      rows.push({
        t: now, number: th.number, tile: tile.tile, status: 'both',
        gapKm: Math.round(gap * 100) / 100,
        theirLat: th.lat, theirLon: th.lon, theirDelay: th.delaySec,
        theirPrev: th.previousStopName, theirNext: th.nextStopName,
        theirAtStation: !!th.atStation, theirSpeed: th.speedMps,
        theirGeneratedAt: tile.generatedAt,
        myLat: m.p.lat, myLon: m.p.lon, myBasis: m.p.basis,
        myFrom: m.p.fromStop ?? m.p.atStation ?? null, myNext: m.p.nextStop ?? null,
        myMaxDelay: m.t.maxDelay,
        myNextStopTime: m.t.calls.find((c) => c.time > now)?.time ?? null,
        myNextStopName: m.t.calls.find((c) => c.time > now)?.name ?? null,
        feedTs: feed.feedTs,
      });
    }
  }

  if (rows.length) await appendFile(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const both = rows.filter((r) => r.status === 'both');
  const gaps = both.map((r) => r.gapKm).sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const big = both.filter((r) => r.gapKm > 5).length;
  const phantom = both.filter((r) => r.theirAtStation && r.myBasis === 'between').length;
  console.log(`[${paris(now)}] ${rows.length} trains | médiane écart ${med} km | >5km: ${big} | "en gare" chez eux mais en ligne chez moi: ${phantom} | absents du flux: ${rows.length - both.length}`);
  return rows.length;
}

await mkdir(path.join(ROOT, 'data'), { recursive: true });
const statics = await loadStatic(path.join(ROOT, 'data'));
console.log(`Comparateur — ${TILES.length} tuiles, toutes les ${PERIOD_MS / 1000}s -> ${OUT}\n`);
for (;;) {
  try { await tick(statics); } catch (e) { console.error('tick:', e.message); }
  await new Promise((r) => setTimeout(r, PERIOD_MS));
}
