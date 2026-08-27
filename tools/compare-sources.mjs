#!/usr/bin/env node
// Compare what each source says about one train, side by side.
//
// Built after 8540 left Bordeaux at ~16:41 while GTFS-RT still said 16:56 and
// TrainTracker24 (which has SIRI ET) said 16:36. If Navitia carries the fresher
// delay, it is worth switching the app's delay source to it.
//
//   SNCF_API_KEY=xxx node src/compare-sources.mjs 8540 "Bordeaux"

import { GtfsStatic } from '../dist-server/server/GtfsStatic.js';
import { FeedClient } from '../dist-server/server/FeedClient.js';
import { hasKey, departures, ping } from './navitia.js';

const num = process.argv[2];
const stationFilter = process.argv[3] ?? '';
if (!num) { console.error('usage: compare-sources.mjs <numéro> [gare]'); process.exit(1); }

const H = (ts) => (ts ? new Date(ts * 1000)
  .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '--:--');

console.log(`\n=== Train ${num} — comparaison des sources ===\n`);

// ---- 1. GTFS-RT (what the app uses today) ----
const statics = await GtfsStatic.load('data');
const { trains, feedTs } = await new FeedClient().load(statics);
const t = trains.find((x) => x.number === num);
console.log(`GTFS-RT (proxy transport.data.gouv.fr) — flux daté ${H(feedTs)}`);
if (!t) console.log('  train absent du flux\n');
else {
  for (const c of t.calls) {
    if (stationFilter && !c.name.toLowerCase().includes(stationFilter.toLowerCase())) continue;
    console.log(`  ${c.name.slice(0, 28).padEnd(30)} arr ${H(c.arrival)} dep ${H(c.departure)}  +${Math.round(c.delay / 60)} min`);
  }
  console.log(`  retard max annoncé : ${Math.round(t.maxDelay / 60)} min\n`);
}

// ---- 2. Navitia / api.sncf.com ----
if (!hasKey()) {
  console.log('Navitia (api.sncf.com) — SNCF_API_KEY absent, source non testée');
  console.log('  clé gratuite : https://numerique.sncf.com/startup/api/token-developpeur/\n');
} else {
  try {
    await ping();
    const station = [...statics.stations.values()]
      .find((s) => s.name.toLowerCase().includes(stationFilter.toLowerCase()));
    if (!station) console.log('Navitia — gare introuvable pour le filtre donné\n');
    else {
      const area = station.stopIds.find((i) => i.startsWith('StopArea:')) ?? station.stopIds[0];
      const deps = await departures(area, { count: 40 });
      const hit = deps.filter((d) => String(d.number) === num);
      console.log(`Navitia — départs de ${station.name} (${area})`);
      if (!hit.length) {
        console.log(`  ${num} pas dans les ${deps.length} prochains départs`);
        for (const d of deps.slice(0, 5)) {
          console.log(`    ${String(d.number).padEnd(8)} ${H(d.departure)} (prévu ${H(d.scheduled)}, +${Math.round((d.delaySec ?? 0) / 60)} min) → ${d.direction ?? ''}`);
        }
      } else {
        for (const d of hit) {
          console.log(`  ${num} : dep ${H(d.departure)} (prévu ${H(d.scheduled)}) → retard ${Math.round((d.delaySec ?? 0) / 60)} min`);
        }
      }
      console.log();
    }
  } catch (e) {
    console.log('Navitia — échec :', e.message, '\n');
  }
}

// ---- 3. TrainTracker24 (public snapshot, for reference) ----
try {
  const r = await fetch('https://www.traintracker24.com/runtime/active-trains.json',
    { headers: { 'user-agent': 'sncf-tracker-research/1.0' } });
  const j = await r.json();
  const hit = j.trains.filter((x) => String(x.number) === num);
  console.log(`TrainTracker24 (SIRI ET) — snapshot ${H(j.generatedAt / 1000)}`);
  for (const x of hit) {
    const prevReal = x.previousStopScheduledTime + x.delaySec;
    const nextReal = x.nextStopScheduledTime + x.delaySec;
    console.log(`  ${x.previousStopName} dep ${H(prevReal)}  →  ${x.nextStopName} arr ${H(nextReal)}`);
    console.log(`  retard : ${Math.round(x.delaySec / 60)} min`);
  }
  if (!hit.length) console.log('  train absent de leur snapshot');
} catch (e) {
  console.log('TrainTracker24 — échec :', e.message);
}
console.log();
