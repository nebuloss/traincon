# Signal positions

`signals.json.gz` is the only data file kept in this repository. Everything
else under `data/` is downloaded at install time by `scripts/fetch-geo.sh` and
is deliberately not committed.

It also rides along as a release asset, so an install pulls it from the same
release as the code it was tested with.

## Only what is read

The tile export it comes from holds 116 818 objects of every kind, with seven
fields each. This file holds 24 673 — a fifth — because that is what the
server actually uses:

* **the stop signals**, `CARRE` and `S`, kept whole. Those are the two that
  can stop a train: the carré is an absolute stop that may not be passed, the
  sémaphore may be passed at caution once the train has stood.
* **the track names, folded per grid cell.** Every other object — whistle
  boards, speed boards, chevrons — contributes exactly one thing, the name of
  the track it stands on, which the server collapses into a set per cell as it
  builds its index. Doing that fold once, here, rather than at every boot, is
  what lets the other 92 000 objects go.

`pk` and `sens` are dropped: nothing reads them.

1.2 MB → 160 kB, and the server parses 24 673 records at boot instead of
116 818.

## The format

```json
{
  "format": 2,
  "source": "https://tiles.tchoo.net/signalisation",
  "attribution": "© OpenStreetMap contributors, ODbL — via carto.tchoo.net",
  "cell": 0.05,
  "count": 24673,
  "lat":   [4846723, ...],   // degrees × 1e5
  "lon":   [-421944, ...],
  "carre": [1, 0, ...],      // 1 = carré, 0 = sémaphore
  "lines": ["420000", ...],
  "line":  [0, 0, 3, ...],   // index into lines, -1 if unknown
  "tracks": [["969,-85", ["V1", "V2"]], ...]
}
```

Columns rather than a record per signal, so the field names appear once
instead of 24 673 times. Coordinates are integers at 1e-5 of a degree, near
enough a metre: measured against the unreduced data, the distance to the next
signal ahead moves by at most **1 m**, and the track counts and line codes
come out identical.

`cell` is the grid size the track sets were folded at, and it must match
`CELL` in `server/Signals.ts`. The loader refuses the file if it does not,
because reading those sets at a different resolution would put them in the
wrong buckets and quietly report the wrong number of tracks.

## Where it came from, and the licence

Derived from the signalling tiles published at
[carto.tchoo.net](https://carto.tchoo.net) — `tiles.tchoo.net/signalisation` —
which are themselves built from OpenStreetMap.

**© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).**
This file is a derived database and carries the same licence. Anything built
from it must keep the attribution, which the application also shows on the map
itself.

## Rebuilding it

Neither the tool that read the tiles nor the one that reduced them is kept
here. Both were written to be run once, and a tile scraper sitting in a public
repository only invites being run again and again against someone else's
server for data that is already published beside it. The network changes
slowly; this file rarely needs remaking.

If it does, the whole method is above: request `{z}/{x}/{y}` from the
`signalisation` tiles over the France bounding box at zoom 8, read `type`,
`line`, `voie` and the coordinates from each feature, then reduce to the shape
in **The format** — keep `CARRE` and `S` whole, fold every object's `voie`
into a set per 0.05° cell, and write the columns.

Ask carto.tchoo.net first.
