# traincon — Go backend

A port of `src/server/`. Every package is ported, the binary serves the whole
API, and it is running on the production container beside the Node service —
`traincon-go` on port 3001, supervised on the same terms, with its own data
directory so it cannot touch the live one's state. The Node service is still
what the public sees.

## Why

Measured on the running server, not assumed:

On the production container, both on the live feed:

| | Node | Go |
|---|---|---|
| heap | 124 MB | **40 MB** |
| resident | 211 MB | **101 MB** |
| boot | seconds | **1.5 s** |

And on the same captured feed, 1 075 trains:

| | TypeScript | Go |
|---|---|---|
| heap | 102 MB | **80 MB** |
| resident | 238 MB | **110 MB** |
| boot | seconds | **under a second** |
| rail graph | 66.1 MB (365 B/node) | **12.8 MB (71 B/node)** |
| graph load | seconds | **215 ms** |
| static schedule load | — | **40 ms** |
| route Paris–Marseille | — | **6.7 ms, 24 allocations** |
| `/api/trains` | 17.3 ms | **~9 ms** |
| `/api/trains?light=1` | 6.9 ms | **~3 ms** |

The graph is the whole argument: 181 290 nodes and 363 946 directed edges
holding 12.4 MB of actual numbers. V8 charges an object header per node because
the adjacency is a slice per node; here it is compressed sparse row, so a
node's edges are a contiguous range of three flat arrays.

## Layout

    cmd/traincon/        the binary
    internal/geo/        great-circle helpers, in km and degrees from north
    internal/gtfs/       the static schedule: stops, stations, train numbers
    internal/feed/       GTFS-RT trip updates, normalised into trains
    internal/rail/       the routing graph, line speeds, Dijkstra, path cache
    internal/motion/     where along a leg a train has got to
    internal/train/      legs, delays, observation quality, and position
    internal/headway/    what the traffic ahead implies
    internal/coupling/   units running joined, and their one true delay
    internal/blocks/     how closely one train may follow another
    internal/signals/    where the signals are, and which can stop a train
    internal/board/      the day's worst delays, kept past the feed window
    internal/disruptions/ why trains are late
    internal/store/      the live picture, and everything served from it
    internal/api/        the JSON API and the client bundle

## Build and test

Everything runs on dev-build; nothing is built on dev-code.

    cd go
    gofmt -l .        # must print nothing
    go vet ./...
    go test ./...

Tests that need the SNCF exports find them at `../data` by default, or wherever
`TRAINCON_DATA` points, and skip when they are absent — so the suite is green on
a machine with no data.

    TRAINCON_DATA=$HOME/traincon/data go test ./...
    TRAINCON_DATA=$HOME/traincon/data go test ./internal/rail/ -bench . -benchmem

## Equivalence with the TypeScript server

The port is pinned to the original at every boundary where a number can be
compared, because "it looks right" is not a check:

- **static schedule** — 8 791 stops, 3 476 stations, 13 698 train numbers from
  the same archive.
- **rail graph** — 181 290 nodes and 363 946 directed edges, which requires the
  in-service filter, vertex snapping, line speeds and the stitching pass all to
  agree.
- **feed decode** — 1 075 trains from the same capture the TypeScript harness
  replays, which exercises the id pattern, the stop lookup, the two-call
  minimum and the join against the schedule.
- **the whole API, on a capture** — both servers on the same fixture, every
  train compared field by field. **992 of 1 040 identical**; the other 48 move
  with the clock, which the three-second skew between the responses accounts
  for.
- **the whole API, live** — both on the production container, waiting until
  they hold the same feed snapshot before comparing. **1 133 of 1 332
  identical.** What is left is accounted for: `traffic`, `speedKmh` and the
  positions come from each process refreshing at its own instant, and
  `reconciled.source` differs because picking the freshest member of a coupled
  set needs revision history the newer process has not accumulated yet.

Those comparisons found six contract breaks no unit test would have: calls
serialised with Go field names rather than the client's; `next` reduced to
three fields where the full DTO carries the whole call; `avgKmh` emitted on
straight-line geometry, which has nothing to average; an unknown service marker
sent as `""` rather than `null`; `lastStop` likewise, on 520 trains at once;
and — found only by fetching for real — `Accept-Encoding: gzip` set by hand,
which turns off net/http's transparent decompression and fed gzip straight to
the protobuf decoder.

`internal/store/contract_test.go` pins each of them, so the next one fails
`go test` rather than waiting for a side-by-side run.

## Dependencies

Two, both maintained, and no hand-written protocol code:

    github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs
    google.golang.org/protobuf

The binding pins a 2021 protobuf runtime; the module upgrades it explicitly.
Everything else is the standard library — `net/http`, `encoding/csv`,
`archive/zip` (which is why there is no longer an `unzip` binary to install),
`compress/gzip`, `encoding/json`.

## Deliberate differences from the TypeScript

Two, both found by tests written against the original's behaviour, and both
recorded where they live:

- `parsePK("-3+500")` is 3.5 km before a line's origin, not 2.5. The TypeScript
  adds the fraction regardless of sign. No negative kilometre point occurs in
  the export — 0 of 4 694 — so no route can change.
- `Position.progress` counts legs completed over legs there are. The TypeScript
  divides the leg index alone, so an arrived train reports half its journey
  done on a three-stop run and none of it on a two-stop one. Nothing on the
  client reads the field.

Everything else is faithful, and pinned by the equivalence tests above.

## Deploying it

`install.sh` installs either server; `TRAINCON_RUNTIME=go` picks this one, and
then there is no Node, no `node_modules` and no `unzip` to install — the
release carries a single static binary. The release workflow builds it with
`CGO_ENABLED=0` and attaches `traincon-linux-amd64`; CI runs `gofmt`, `go vet`
and `go test` on every push.

## Not yet done

- **The cutover.** Production still runs the Node service. Switching it means
  re-running the installer with `TRAINCON_RUNTIME=go`, and it should follow a
  soak long enough to cover a full day — including the twelve-hourly static
  refresh, which is what killed the Node process on five separate days.
- The store has no test that boots it against real data; the contract tests
  cover the wire format, and the side-by-side covers the rest.

The client stays TypeScript and needs no changes: the contract between them is
JSON, and the only behaviour shared across the boundary is `plausibleSpeed` and
`deeplink`, under 40 lines. `distanceFraction` is client-only — the server sends
the profile, the client evaluates it — so there is no motion model to
duplicate.
