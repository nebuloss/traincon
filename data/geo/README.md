# Signal positions

`signals.json.gz` is the only data file kept in this repository. Everything
else under `data/` is downloaded at install time by `scripts/fetch-geo.sh` and
is deliberately not committed.

## What it is

116 818 lineside signals of the French national network, each with its
position, its kind, and where it sits on the line:

```json
{ "lat": 48.467231, "lon": -4.219437, "type": "A",
  "line": "420000", "pk": "600+272", "sens": "C", "voie": "V1" }
```

| field  | meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `type` | signal kind — `CARRE`, `S`, `A`, `TIV D FIXE`, `CV`, and others |
| `line` | infrastructure line number                                      |
| `pk`   | point kilométrique, `km+m`                                      |
| `sens` | direction of travel the signal applies to                       |
| `voie` | track it stands on — `V1`, `V2`, `UNIQUE`, …                    |

Two of the kinds carry the weight for this application: `CARRE`, the absolute
stop that may not be passed, and `S`, the sémaphore that may be passed at
caution once the train has stood. `server/Signals.ts` indexes those to answer
"what is the next signal that could stop this train, and how far ahead".

## Where it came from, and the licence

Derived from the signalling tiles published at
[carto.tchoo.net](https://carto.tchoo.net) — `tiles.tchoo.net/signalisation` —
which are themselves built from OpenStreetMap.

**© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).**
This file is a derived database and carries the same licence. Anything built
from it must keep the attribution, which the application also shows on the map
itself.

## How it was made, and why the tool is not here

Read once from the vector tiles at zoom 8 — a hundred tiles covering France,
decoded from Mapbox Vector Tile format and flattened to the rows above.

The tool that did it is not in this repository. It existed to be run a single
time, and leaving a tile scraper in a public repo invites it to be run
repeatedly against somebody else's server for data that is already sitting
here. `scripts/fetch-geo.sh` now downloads this file instead, which costs that
server nothing.

If it ever needs regenerating — the network changes slowly, so rarely — the
method above is the whole of it: request `{z}/{x}/{y}` over the France bounding
box at z8, read the `signalisation` layer, and keep the fields listed above.
Ask carto.tchoo.net first.
