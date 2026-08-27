#!/usr/bin/env node
// Feed revision logger.
//
// The GTFS-RT feed is the only observation channel we have for French trains,
// so every revision it publishes is a data point. This records them to JSONL
// so we can answer, after the fact: when did SNCF actually revise this train,
// and how far ahead of reality was the prediction?
//
//   node src/logger.mjs 8540 8582            # follow these trains
//   node src/logger.mjs --all-tgv            # every TGV
//
// Output: data/revisions.jsonl (one line per observed change)

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GtfsStatic, serviceMeta } from '../dist-server/server/GtfsStatic.js';
import { FeedClient } from '../dist-server/server/FeedClient.js';
import { Train } from '../dist-server/server/Train.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'revisions.jsonl');
const PERIOD_MS = Number(process.env.PERIOD_MS ?? 20_000);

const args = process.argv.slice(2);
const allTgv = args.includes('--all-tgv');
const watch = new Set(args.filter((a) => /^\d+$/.test(a)));

const paris = (ts) =>
  new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

// Last seen per-stop prediction, so we only log genuine changes.
const seen = new Map(); // number -> { feedTs, calls: Map(stopId -> {time, delay}), basis }

async function tick(statics) {
  const { trains: raw, feedTs } = await new FeedClient().load(statics);
  const trains = raw.map((r) => new Train(r));
  const now = Math.floor(Date.now() / 1000);
  const events = [];

  for (const t of trains) {
    const isTgv = ['OUI', 'OGO', 'LYR'].includes(t.service);
    if (!(watch.has(t.number) || (allTgv && isTgv))) continue;

    const pos = t.positionAt(now);
    const prev = seen.get(t.number);
    const cur = new Map(t.calls.map((c) => [c.stopId, { time: c.time, delay: c.delay, name: c.name }]));

    if (prev) {
      for (const [stopId, c] of cur) {
        const p = prev.calls.get(stopId);
        if (!p) continue;
        if (p.time !== c.time) {
          events.push({
            kind: 'revision', number: t.number, service: serviceMeta(t.service).label,
            stop: c.name, from: p.time, to: c.time, shiftSec: c.time - p.time,
            delayFrom: p.delay, delayTo: c.delay,
            observedAt: now, feedTs,
          });
        }
      }
      if (prev.basis !== pos.basis || prev.nextStop !== pos.nextStop) {
        events.push({
          kind: 'segment', number: t.number,
          from: `${prev.basis}${prev.nextStop ? ' -> ' + prev.nextStop : ''}`,
          to: `${pos.basis}${pos.nextStop ? ' -> ' + pos.nextStop : ''}`,
          observedAt: now, feedTs,
        });
      }
    } else {
      events.push({
        kind: 'first_seen', number: t.number, service: serviceMeta(t.service).label,
        origin: t.origin, destination: t.destination, maxDelay: t.maxDelay,
        calls: t.calls.map((c) => ({ stop: c.name, time: c.time, delay: c.delay })),
        observedAt: now, feedTs,
      });
    }
    seen.set(t.number, { feedTs, calls: cur, basis: pos.basis, nextStop: pos.nextStop });
  }

  if (events.length) {
    await appendFile(OUT, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    for (const e of events) {
      if (e.kind === 'revision') {
        const sign = e.shiftSec > 0 ? '+' : '';
        console.log(`[${paris(e.observedAt)}] ${e.number} ${e.stop}: ${paris(e.from)} -> ${paris(e.to)} (${sign}${Math.round(e.shiftSec / 60)} min)`);
      } else if (e.kind === 'segment') {
        console.log(`[${paris(e.observedAt)}] ${e.number} segment: ${e.from}  =>  ${e.to}`);
      } else {
        console.log(`[${paris(e.observedAt)}] ${e.number} suivi (${e.origin} -> ${e.destination}, +${Math.round(e.maxDelay / 60)} min)`);
      }
    }
  }
  return { feedTs, n: trains.length };
}

await mkdir(path.join(ROOT, 'data'), { recursive: true });
const statics = await GtfsStatic.load(path.join(ROOT, 'data'));
console.log(`Logger démarré — ${allTgv ? 'tous les TGV' : [...watch].join(', ')} — toutes les ${PERIOD_MS / 1000}s`);
console.log(`Sortie : ${OUT}\n`);
for (;;) {
  try { await tick(statics); } catch (e) { console.error('tick failed:', e.message); }
  await new Promise((r) => setTimeout(r, PERIOD_MS));
}
