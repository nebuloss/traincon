# Traincon

*trinquons* + *ce train con* — because the app exists for the trains that are
being exactly that.

Live tracking for French trains — TGV, Intercités and TER — built on SNCF open
data. Follow a train, see where it is on the network, and get the real time it
will reach your station.

**No API key required.** The schedule, the real-time feed and the rail geometry
are all open data.

```bash
curl -fsSL https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
```

A minimal Alpine has `wget` but not `curl`, so there it is:

```bash
wget -qO- https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
```

Interface in French and English, light and dark themes, mobile-first.

## What it does

- **Follow trains** — bookmark by number and see their progress at a glance
- **Journey view** — every stop with its live arrival time and delay
- **Map** — the train projected onto the actual track, zoomed to match its speed
- **Log** — how much the current estimate can be trusted, and what has changed
- **Shareable links** — `/train/8540` opens straight on that train
- **Hall of shame** — the day's worst delays, with SNCF's own stated reason

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
curl -fsSL https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh

# a minimal Alpine ships wget but not curl
wget -qO- https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh

# with an optional SNCF API key
curl -fsSL .../install.sh | SNCF_API_KEY=xxxx sh
```

Nothing else needs installing first: the script fetches Node, the application,
the rail geometry and the signal positions itself. Verified from a bare Alpine
container — see `docs/clean-install.md`.

Installs to `/opt/traincon`, runs as a service (systemd or OpenRC), listens on
port 3000. Re-run the same command to update — `data/` is preserved so the
24 MB of schedule and geometry are not re-downloaded.

| Variable | Default | |
|---|---|---|
| `APP_PORT` | `3000` | listen port |
| `APP_DIR` | `/opt/traincon` | install directory |
| `SNCF_API_KEY` | — | optional, enables disruption reasons |
| `FETCH_GEO` | `1` | `0` skips the 19 MB rail geometry |
| `VERSION` | newest | install a specific tag, e.g. `v2.1.0` |
| `RAIL_PATH_POINTS` | `400000` | vertex budget for the routed-path cache (~12 MB) |
| `GOMEMLIMIT` | 80% of the container | soft ceiling; the collector works harder rather than the process dying |
| `PUBLIC_URL` | — | pins the origin in the link-preview tags; derived from the request otherwise |

## On a machine with nothing on it

Verified, not assumed: a bare Alpine LXC container, 1 core, 512 MB of memory,
2 GB of disk, network and nothing else. No Node, no Go, no curl, no API key.

```bash
wget -qO- https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
```

The script picks the build for the machine's architecture, checks it against
the release's published digest, downloads the data, creates the service user,
writes the service and starts it. It ends with the number of trains it is
tracking, which is the useful confirmation — an install that gets that far is
working.

What it reaches for, all public and none needing an account:

| what | from |
| --- | --- |
| the installer | raw.githubusercontent.com |
| the release, by tag | api.github.com, then the release assets |
| the server | `traincon-linux-{amd64,arm64,armv7}`, verified against `SHA256SUMS` |
| the client bundle | `traincon.tar.gz`, built by CI |
| signal positions | `signals.json.gz` on the release |
| rail geometry, line speeds, block modes | SNCF Réseau open data |

And, in the browser rather than at install time: MapLibre from unpkg, the
basemap from CARTO, and the surveyed track tiles from carto.tchoo.net.

What it does not need:

* **No runtime.** The server is one static binary. The client is compiled to
  JavaScript by CI, so nothing on the target ever sees TypeScript.
* **No package manager.** `curl` and `tar` are the whole list of requirements.
* **No API key.** The schedule, the real-time feed and the geometry are all
  open data. A key adds disruption reasons; without one the installer says so
  and carries on.
* **No build step.** The artwork — six vehicle drawings, four signal drawings,
  the icons — is inlined into the bundle, so there are no separate asset files
  to go missing.

Updating is the same command. `data/` is preserved, so the geometry is not
downloaded again.

## Development

A Go server and a TypeScript client. The server is one static binary with two
dependencies; the client is bundled by Vite.

```bash
npm install
npm run fetch:geo     # rail network geometry, ~19 MB, once
npm run build         # vite, into dist/
npm run server        # go run ./cmd/traincon — http://localhost:3000
npm run dev           # Vite dev server, proxying /api to :3000
npm run typecheck     # the client
npm test              # the client
npm run server:test   # gofmt, go vet, go test
```

```
go/cmd/traincon/      the binary
go/internal/gtfs/     the static schedule
go/internal/feed/     GTFS-RT trip updates
go/internal/rail/     the routing graph, and paths over it
go/internal/train/    legs, delays, position
go/internal/store/    the live picture, and everything served from it
go/internal/api/      the JSON API and the bundle
src/types.ts          the API contract the client reads
src/core/             I18n · Api · Cache · Format · Bookmarks · Theme
src/components/       Timeline · TrainCard · MapView · TrainModal · Banner
src/views/            WatchView · SearchView
scripts/              fetch-geo.sh, and standalone diagnostics
```

The contract between the two is JSON, not code. `src/types.ts` declares
what the client expects and `go/internal/store` produces it, so the two can no
longer be kept in agreement by the compiler — `go/internal/store/contract_test.go`
does it instead, pinning every field name and every value that must be null
rather than empty. It exists because comparing the two servers field by field,
during the port, found six breaks that nothing else would have caught.

The behaviour that genuinely spans the boundary is under forty lines: the speed
ceiling a train is held to, and the deep-link parser. The motion model does not
— the server samples each leg's profile and sends it, the client only reads it,
so there is one curve rather than two implementations of one.

The upstream feed goes down regularly, so development does not depend on it:

```bash
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
| `GET /api/worst?limit=25` | the day's worst delays, with reasons |
| `GET /api/rail.geojson` | in-service network, gzipped |
| `GET /api/refresh` | force an upstream retry |

## Delay reasons

GTFS-RT carries delays but never says why. The cause comes from the SNCF
(Navitia) disruption feed, which publishes a plain-French message per affected
journey — *Obstacle sur la voie*, *Défaillance de matériel*, *Réutilisation
d'un train* — keyed by train number.

This needs `SNCF_API_KEY`; without one the board still ranks, it just cannot
say why. Measured coverage is about **72%** of trains more than ten minutes
down, and 19 of a given day's worst 20.

Two design notes worth knowing before changing it:

- **The whole disruption list is swept and indexed, rather than queried per
  train.** Filtering `vehicle_journeys` by `has_headsign` looks like the
  obvious approach and does not work — it returns unrelated coach services,
  and scored 0 hits on 20 known-delayed trains.
- **The free key allows 5 000 requests a day.** A full sweep is ~18 pages, so
  the 15-minute cycle costs ~1 700 a day.

The board itself is kept separately from the live store, which prunes trains
two hours after they leave the feed — by evening the morning's worst would
otherwise be gone. It records a high-water mark per train, persists to
`data/daily-board.json`, and resets when the Paris day rolls over.

## Links

Any of these opens a train directly, so a link pasted into a message lands on
it. The address bar is rewritten to the first form, which is what you get by
copying it afterwards.

```
/                        mes trains        /watch
/recherche               recherche         /search
/palmares                palmarès du jour  /worst

/train/8540              /t/8540
/train/8540/carte        tabs: apercu trajet carte journal
?train=8540&tab=carte    #8540      #train=8540
```

Each tab has its own path, so Back walks through them and a link opens on the
right one. A train link opens its modal over whichever tab you were on.

Tabs are also accepted by their English names (`overview`, `journey`, `map`,
`log`), so a link shared from the English interface reads naturally.

Link previews in WhatsApp, Signal, Slack and the rest come from the Open Graph
tags, and a link to one train carries that train's own card:

> **TGV INOUI 8540 · Hendaye → Paris Montparnasse**
> Retard 1 h 30 · prochain arrêt Dol-de-Bretagne à 11:11 · arrivée Saint-Malo à 11:25

Those tags need an absolute URL for the image; it is taken from
`X-Forwarded-Host`/`Host` per request, so a reverse proxy needs no extra
configuration — set `PUBLIC_URL` to override. The card image itself is static;
re-run `python3 scripts/make-og-image.py` after changing the artwork.

Note that WhatsApp caches a preview for days, so a link shared before a change
keeps the old card until the cache expires or the URL changes.

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
