// Package signals says where the signals are, and which of them can stop a
// train.
//
// 24 673 stop signals covering the whole national network, from the signalling
// layer published by Carto Tchoo — see data/geo/README.md for the provenance and
// why the alternatives were not usable.
//
// The published file carries only what is read here. The tile export it comes
// from holds 116 818 objects of every kind; four fifths of them are whistle
// boards, speed boards and the like, which this needs for exactly one thing —
// the name of the track they stand on — so that is folded into a set per grid
// cell when the file is made.
//
// The two kinds that matter for spacing:
//
//	CARRE  non franchissable — an absolute stop. A train may not pass it.
//	S      sémaphore, franchissable — stop, then proceed at caution.
//
// Both stop a train, which is what a braking curve needs; the difference is what
// happens afterwards, and that is beyond what can be inferred without live
// aspects.
package signals

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"traincon/internal/geo"
)

// cellDeg is the grid cell, about 5.5 km, so a lookup touches few candidates.
const cellDeg = 0.05

// Kinds of signal that can bring a train to a stand.
const (
	KindCarre     = "carre"
	KindSemaphore = "semaphore"
)

// Signal is one signal on the network.
type Signal struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
	// Type is CARRE or S in the raw export.
	Type string `json:"type"`
	// Line is the infrastructure line code, so signals can be kept to the
	// train's own line.
	Line string `json:"line"`
	// Voie is the track this stands on: V1, V2, UNIQUE for single track, or a
	// yard name.
	Voie string `json:"voie"`
}

// Stops reports whether this signal can bring a train to a stand.
func (s Signal) Stops() bool { return s.Type == "CARRE" || s.Type == "S" }

// Kind is how the signal is described outside this package.
func (s Signal) Kind() string {
	if s.Type == "CARRE" {
		return KindCarre
	}
	return KindSemaphore
}

// Layout is how many tracks there are at a point, and whether it is single.
type Layout struct {
	// Single means trains in opposite directions cannot pass, so they
	// constrain each other absolutely rather than only when following.
	Single bool
	// Tracks is the number of distinct running tracks seen nearby.
	Tracks int
}

// Ahead is the next stop signal a train is running towards.
type Ahead struct {
	Signal    Signal
	DistanceM float64
}

// runningTrack matches a track name that denotes a running line rather than a
// yard or platform road.
var runningTrack = regexp.MustCompile(`(?i)^V?\d+(BIS|TER)?$`)

// Index answers where the next stop signal is, and what the track layout is.
type Index struct {
	cells map[int64][]Signal
	// tracks holds the track names seen in each cell, from every object rather
	// than only the stop signals — a stretch of plain single track carries
	// whistle boards and speed boards but few carrés, and dropping those would
	// make it look double-tracked.
	tracks map[int64]map[string]struct{}
	count  int
}

// New indexes a set of signals.
func New(list []Signal) *Index {
	idx := &Index{cells: make(map[int64][]Signal), tracks: make(map[int64]map[string]struct{})}
	for _, s := range list {
		k := cellKey(s.Lat, s.Lon)
		if s.Voie != "" {
			if idx.tracks[k] == nil {
				idx.tracks[k] = make(map[string]struct{})
			}
			idx.tracks[k][s.Voie] = struct{}{}
		}
		if !s.Stops() {
			continue
		}
		idx.cells[k] = append(idx.cells[k], s)
		idx.count++
	}
	return idx
}

// Size reports how many stop signals are indexed.
func (i *Index) Size() int {
	if i == nil {
		return 0
	}
	return i.count
}

func cellKey(lat, lon float64) int64 {
	return int64(int32(math.Floor(lat/cellDeg)))<<32 | int64(uint32(int32(math.Floor(lon/cellDeg))))
}

// headingGap is the smallest angle between two headings, in degrees.
func headingGap(a, b float64) float64 {
	d := math.Mod(math.Abs(a-b), 360)
	if d > 180 {
		return 360 - d
	}
	return d
}

// TracksNear reports the track layout around a point.
//
// UNIQUE is published explicitly for single track, which is better than
// inferring it from a count: a quiet double-track section might carry only one
// signal in a cell and look single by accident.
//
// Yard and platform names (A, B, 3, 4…) are counted but do not make a line "not
// single": a passing loop at a station on a single-track line is still a
// single-track line either side of it.
func (i *Index) TracksNear(lat, lon float64) Layout {
	if i == nil {
		return Layout{}
	}
	ci := int32(math.Floor(lat / cellDeg))
	cj := int32(math.Floor(lon / cellDeg))

	seen := make(map[string]struct{})
	for x := ci - 1; x <= ci+1; x++ {
		for y := cj - 1; y <= cj+1; y++ {
			for v := range i.tracks[int64(x)<<32|int64(uint32(y))] {
				seen[v] = struct{}{}
			}
		}
	}
	if len(seen) == 0 {
		return Layout{}
	}

	running := 0
	for v := range seen {
		if runningTrack.MatchString(v) || strings.EqualFold(v, "UNIQUE") {
			running++
		}
	}
	_, hasUnique := seen["UNIQUE"]
	_, hasV2 := seen["V2"]
	tracks := running
	if tracks == 0 {
		tracks = len(seen)
	}
	return Layout{Single: hasUnique && !hasV2, Tracks: tracks}
}

// NextAhead returns the next stop signal a train is running towards.
//
// "Ahead" means within 60° of the direction of travel, judged from the bearing
// to the signal — enough to exclude the one just passed, which is behind by
// definition, without needing to know which track the train is on.
//
// Signals face a direction and the layer records it, but a train's track is not
// known well enough to use: the position is an estimate projected onto a line,
// and stations have several parallel tracks a few metres apart. So this reports
// the nearest stop signal ahead on the same line and leaves the caller to treat
// it as approximate.
func (i *Index) NextAhead(lat, lon, bearing, maxKm float64, line string) (Ahead, bool) {
	if i == nil {
		return Ahead{}, false
	}
	rings := int32(math.Ceil(maxKm/(cellDeg*111))) + 1
	ci := int32(math.Floor(lat / cellDeg))
	cj := int32(math.Floor(lon / cellDeg))

	var best Ahead
	found := false
	for x := ci - rings; x <= ci+rings; x++ {
		for y := cj - rings; y <= cj+rings; y++ {
			for _, s := range i.cells[int64(x)<<32|int64(uint32(y))] {
				if line != "" && s.Line != "" && s.Line != line {
					continue
				}
				km := geo.HaversineAt(lat, lon, s.Lat, s.Lon)
				if km > maxKm {
					continue
				}
				// Too close to tell ahead from behind; treat as already passed.
				if km < 0.02 {
					continue
				}
				if headingGap(bearing, geo.Bearing(geo.Point{Lat: lat, Lon: lon}, geo.Point{Lat: s.Lat, Lon: s.Lon})) > 60 {
					continue
				}
				if m := math.Round(km * 1000); !found || m < best.DistanceM {
					best, found = Ahead{Signal: s, DistanceM: m}, true
				}
			}
		}
	}
	return best, found
}

// LineAt returns the infrastructure line code at a point, from the nearest
// signal.
//
// Trains carry a commercial line label — "Paris - Rennes - Saint-Malo TGV" — and
// two trains sharing a physical route routinely carry different ones, so
// grouping by it finds almost no pairs. The infrastructure code is the same for
// both, because it describes the track rather than the service.
func (i *Index) LineAt(lat, lon, maxKm float64) string {
	if i == nil {
		return ""
	}
	ci := int32(math.Floor(lat / cellDeg))
	cj := int32(math.Floor(lon / cellDeg))
	rings := int32(math.Ceil(maxKm/(cellDeg*111))) + 1

	best, bestKm := "", math.Inf(1)
	for x := ci - rings; x <= ci+rings; x++ {
		for y := cj - rings; y <= cj+rings; y++ {
			for _, s := range i.cells[int64(x)<<32|int64(uint32(y))] {
				if s.Line == "" {
					continue
				}
				if km := geo.HaversineAt(lat, lon, s.Lat, s.Lon); km < bestKm && km <= maxKm {
					bestKm, best = km, s.Line
				}
			}
		}
	}
	return best
}

// packed is the published form: columns rather than records.
//
// Only the stop signals are carried whole. Everything else in the tile export
// contributes one thing — the name of the track it stands on — and that is
// folded into Tracks when the file is made rather than at every boot. It is a
// fifth of the objects and an eighth of the bytes.
type packed struct {
	Format int `json:"format"`
	// Cell is the cell size the track sets were folded at. Written down
	// because a reader using a different one would bucket them wrongly and
	// quietly report the wrong number of tracks.
	Cell  float64 `json:"cell"`
	Count int     `json:"count"`
	// Lat and Lon are degrees times 1e5 — about a metre, far finer than the
	// model asks.
	Lat []int64 `json:"lat"`
	Lon []int64 `json:"lon"`
	// Carre is 1 for a carré, which may not be passed; 0 for a sémaphore.
	Carre []int    `json:"carre"`
	Lines []string `json:"lines"`
	// Line indexes into Lines, or -1 where the line is not known.
	Line []int `json:"line"`
	// Tracks is the folded track set per cell: ["<i>,<j>", ["V1","V2",…]].
	Tracks [][]any `json:"tracks"`
	// Raw is the unpacked tile export, for a file written before format 2.
	Raw []Signal `json:"rows"`
}

// Load reads the signalling layer from dataDir/geo.
//
// A missing or unreadable file is not an error: signalling is a refinement, not
// a requirement, and the caller gets a nil Index whose methods answer emptily.
func Load(dataDir string) (*Index, error) {
	path := filepath.Join(dataDir, "geo", "signals.json")
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var p packed
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("signals: %s: %w", path, err)
	}
	if p.Format == 2 {
		return fromPacked(&p)
	}
	// The raw tile export, as published before the file was packed down. An
	// installation that has not fetched again since still has one of these.
	if len(p.Raw) > 0 {
		return New(p.Raw), nil
	}
	return nil, nil
}

// fromPacked rebuilds the index from the published columns.
func fromPacked(p *packed) (*Index, error) {
	if p.Cell != cellDeg {
		// Refusing is better than answering wrongly: the track sets were folded
		// at the file's cell size, and reading them at another would put them
		// in the wrong buckets.
		slog.Warn("signals: cell size mismatch, ignoring the layer",
			"file", p.Cell, "build", cellDeg)
		return nil, nil
	}

	list := make([]Signal, 0, p.Count)
	for i := range p.Count {
		if i >= len(p.Lat) || i >= len(p.Lon) {
			break
		}
		kind := "S"
		if i < len(p.Carre) && p.Carre[i] == 1 {
			kind = "CARRE"
		}
		line := ""
		if i < len(p.Line) {
			if li := p.Line[i]; li >= 0 && li < len(p.Lines) {
				line = p.Lines[li]
			}
		}
		list = append(list, Signal{
			Lat:  float64(p.Lat[i]) / 1e5,
			Lon:  float64(p.Lon[i]) / 1e5,
			Type: kind,
			Line: line,
		})
	}

	idx := New(list)
	// The folded track sets: ["<i>,<j>", ["V1","V2",…]] per cell.
	for _, entry := range p.Tracks {
		if len(entry) != 2 {
			continue
		}
		key, ok := entry[0].(string)
		if !ok {
			continue
		}
		names, ok := entry[1].([]any)
		if !ok {
			continue
		}
		var i, j int32
		if _, err := fmt.Sscanf(key, "%d,%d", &i, &j); err != nil {
			continue
		}
		k := int64(i)<<32 | int64(uint32(j))
		if idx.tracks[k] == nil {
			idx.tracks[k] = make(map[string]struct{})
		}
		for _, n := range names {
			if name, ok := n.(string); ok {
				idx.tracks[k][name] = struct{}{}
			}
		}
	}
	return idx, nil
}
