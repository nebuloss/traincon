# Suivi TGV

Live tracking for French trains — TGV, Intercités and TER — built on SNCF open
data. Follow a train, see where it is on the network, and get the real time it
will reach your station.

**No API key required.** The schedule, the real-time feed and the rail geometry
are all open data.

```bash
curl -fsSL https://raw.githubusercontent.com/nebuloss/suivi-tgv/main/install.sh | sh
```

Interface in French and English, light and dark themes, mobile-first.

## What it does

- **Follow trains** — bookmark by number and see their progress at a glance
- **Journey view** — every stop with its live arrival time and delay
- **Map** — the train projected onto the actual track, zoomed to match its speed
- **Log** — how much the current estimate can be trusted, and what has changed

## What the data can and cannot tell you

**SNCF publishes no GPS.** Nothing does, for French trains — there is no
equivalent of ADS-B. Every map showing a moving French train, this one included,
is interpolating from the timetable.

So the app draws a hard line between the two kinds of number it shows:

- **Times are SNCF's own real-time forecasts.** Not computed here. When the app
  says a train reaches Bordeaux at 16:30, that is SNCF's figure.
- **Positions are derived.** The train is placed along the real track geometry
  using the line speed limits, then scaled onto the live schedule. Good enough
  to be useful, never a measurement — and labelled as such.

The app also reports **how stale the estimate is**. GTFS-RT only revises a train
when it calls somewhere, so on a long leg with no intermediate stop the
published delay is simply carried forward. A train unobserved for 70 minutes is
flagged accordingly rather than shown with the same confidence as one that just
left a platform.

## Data sources

| Source | Key | Contents |
|---|---|---|
| [GTFS-RT trip updates](https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates) | no | live delays, ~1500 trains, ~8 h ahead |
| [GTFS static](https://transport.data.gouv.fr/datasets/horaires-sncf) | no | stations, coordinates, train numbers |
| [SNCF Réseau geometry](https://ressources.data.sncf.com/explore/dataset/formes-des-lignes-du-rfn/) | no | 1638 line sections, line speeds |
| [api.sncf.com](https://numerique.sncf.com/startup/api/token-developpeur/) | yes | optional: disruption reasons, station boards |

## Install

```bash
# as root, on the host that will serve it
curl -fsSL https://raw.githubusercontent.com/nebuloss/suivi-tgv/main/install.sh | sh

# with an optional SNCF API key
curl -fsSL .../install.sh | SNCF_API_KEY=xxxx sh
```

Installs to `/opt/suivi-tgv`, runs as a service (systemd or OpenRC), listens on
port 3000. Re-run the same command to update — `data/` is preserved so the
24 MB of schedule and geometry are not re-downloaded.

| Variable | Default | |
|---|---|---|
| `APP_PORT` | `3000` | listen port |
| `APP_DIR` | `/opt/suivi-tgv` | install directory |
| `SNCF_API_KEY` | — | optional, enables disruption reasons |
| `FETCH_GEO` | `1` | `0` skips the 19 MB rail geometry |

## Development

```bash
npm install
npm run fetch:geo     # rail network geometry, ~19 MB, once
npm start             # http://localhost:3000
npm test
```

The upstream feed goes down regularly, so development does not depend on it:

```bash
npm run dev:replay    # replays fixtures/sncf-trip-updates.pb
```

`SNCF_FEED_SHIFT=auto` (the default) rebases a capture's timestamps onto the
current time, which is what makes an old capture behave like a live feed rather
than a set of trains that have already arrived. Replayed data is always flagged
`replay: true` and never cached as if it were real.

| Variable | Effect |
|---|---|
| `SNCF_FEED_FILE` | replay a `.pb` capture instead of the network |
| `SNCF_FEED_SHIFT` | `auto`, `none`, or an offset in seconds |
| `SNCF_FEED_FALLBACK` | capture served as a last resort when live fails |
| `SNCF_FEED_URL` | override the upstream URL |

## When the feed goes down

`proxy.transport.data.gouv.fr` is not always up. Three layers, each stating
which it is rather than passing itself off as live:

1. **Browser cache** — responses kept in `localStorage`, so a reload with no
   connectivity still shows your trains
2. **Server snapshot** — the last good decode on disk, for when upstream is down
3. **Fixture replay** — optional, when there is nothing else

## API

| Route | |
|---|---|
| `GET /api/stats` | feed health and counts |
| `GET /api/suggest?q=` | autocomplete over live trains |
| `GET /api/train/:number` | one train, all its calls |
| `GET /api/train/:number/path` | its route as GeoJSON |
| `GET /api/trains?family=tgv&light=1` | filtered list |
| `GET /api/rail.geojson` | in-service network, gzipped |
| `GET /api/refresh` | force an upstream retry |

## Notes

A few things that are not obvious from the data:

- **A station is several stop_ids.** One `StopArea` plus one `StopPoint` per
  operator, sharing a UIC code. Query one and a departure board shows a single
  operator's trains. They are grouped by UIC — 8929 ids become 3524 stations.
- **The two feeds do not join directly.** Real-time uses short trip ids
  (`OCESN8540F`), the static GTFS long ones. The join is on the train number.
- **Only in-service track is routable.** The RFN export also ships neutralised,
  closed and downgraded lines; routing over those puts trains on track
  abandoned for decades.
- **Routing minimises time, not distance.** Otherwise a TGV Paris–Bordeaux is
  sent down the classic line because it is shorter in kilometres.
- **Coupled units carry two numbers.** SNCF publishes a record per number and
  lets one go stale, so the two halves of one physical train can disagree by
  20 minutes. The app surfaces the conflict rather than hiding it.

## Licence

MIT
