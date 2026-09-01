# traincon — Go backend

A port of `src/server/`, in progress. The TypeScript server is still the one
that runs; this tree is built and tested alongside it until it can replace it.

## Why

Measured on the running server, not assumed:

| | TypeScript | Go |
|---|---|---|
| rail graph | 66.1 MB (365 B/node) | **12.8 MB (71 B/node)** |
| graph load | seconds | **215 ms** |
| static schedule load | — | **40 ms** |
| route Paris–Marseille | — | **6.7 ms, 24 allocations** |

The graph is the whole argument: 181 290 nodes and 363 946 directed edges
holding 12.4 MB of actual numbers. V8 charges an object header per node because
the adjacency is a slice per node; here it is compressed sparse row, so a
node's edges are a contiguous range of three flat arrays.

## Layout

    cmd/traincon/        the binary
    internal/geo/        great-circle helpers, in km and degrees from north
    internal/gtfs/       the static schedule: stops, stations, train numbers
    internal/feed/       GTFS-RT trip updates, normalised into trains
    internal/rail/       the routing graph, line speeds, and Dijkstra

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

These are the tests to keep green while the rest is ported.

## Dependencies

Two, both maintained, and no hand-written protocol code:

    github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs
    google.golang.org/protobuf

The binding pins a 2021 protobuf runtime; the module upgrades it explicitly.
Everything else is the standard library — `net/http`, `encoding/csv`,
`archive/zip` (which is why there is no longer an `unzip` binary to install),
`compress/gzip`, `encoding/json`.

## Still to port

`Train`, `TrainStore`, `Headway`, `Signals`, `Blocks`, `DailyBoard`,
`Disruptions`, `CouplingDetector` and the HTTP layer — about 3 000 lines. The
client stays TypeScript and needs no changes: the contract between them is
JSON, and the only behaviour shared across the boundary is `plausibleSpeed` and
`deeplink`, under 40 lines. `distanceFraction` is client-only — the server
sends the profile, the client evaluates it — so there is no motion model to
duplicate.
