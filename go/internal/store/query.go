package store

import (
	"math"
	"runtime"
	"sort"
	"strings"
	"time"

	"traincon/internal/board"
	"traincon/internal/gtfs"
	"traincon/internal/motion"
	"traincon/internal/rail"
	"traincon/internal/train"
)

// Suggestion is one autocomplete row.
type Suggestion struct {
	Number       string      `json:"number"`
	ServiceLabel string      `json:"serviceLabel"`
	Family       gtfs.Family `json:"family"`
	Origin       string      `json:"origin"`
	Destination  string      `json:"destination"`
	Delay        int64       `json:"delay"`
	Cancelled    bool        `json:"cancelled"`
	Basis        train.Basis `json:"basis"`
	CoupledWith  []string    `json:"coupledWith"`
	Next         *NextCall   `json:"next"`
	// Why names the field that matched, so the row can show it.
	Why   string `json:"why"`
	Score int    `json:"score"`
}

// score ranks how well a train answers a query, and names what matched. An
// exact number match ranks first, then a prefix, then anything else.
func score(t *train.Train, q string) (int, string) {
	dest := strings.ToLower(t.Destination())
	orig := strings.ToLower(t.Origin())
	switch {
	case t.Number == q:
		return 100, "number"
	case strings.HasPrefix(t.Number, q):
		return 90, "number"
	case strings.Contains(t.Number, q):
		return 70, "number"
	case strings.HasPrefix(dest, q):
		return 60, "destination"
	case strings.HasPrefix(orig, q):
		return 55, "origin"
	case strings.Contains(dest, q):
		return 45, "destination"
	case strings.Contains(orig, q):
		return 40, "origin"
	}
	for _, c := range t.Calls {
		if strings.Contains(strings.ToLower(c.Name), q) {
			return 30, "serves:" + c.Name
		}
	}
	return -1, ""
}

// Suggest autocompletes over the live trains: by number, by origin or
// destination, or by any station served.
func (s *Store) Suggest(query string, family gtfs.Family, limit int) []Suggestion {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return []Suggestion{}
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().Unix()

	rows := make([]Suggestion, 0, 32)
	for _, t := range s.trains {
		meta := gtfs.Service(t.Service)
		if family != "" && meta.Family != family {
			continue
		}
		points, why := score(t, q)
		if points < 0 {
			continue
		}
		leg := t.LegAt(now)
		if leg.Basis == train.Between || leg.Basis == train.AtStation {
			points += 5 // a train actually running is the more useful answer
		}
		delay := t.CurrentDelay(now)
		if rec, ok := s.couples.Delays[t.Number]; ok {
			delay = rec.Delay
		}
		partners := s.couples.Partners[t.Number]
		if partners == nil {
			partners = []string{}
		}
		rows = append(rows, Suggestion{
			Number: t.Number, ServiceLabel: meta.Label, Family: meta.Family,
			Origin: t.Origin(), Destination: t.Destination(),
			Delay: delay, Cancelled: t.Cancelled, Basis: leg.Basis,
			CoupledWith: partners, Next: nextCallOf(t, now),
			Why: why, Score: points,
		})
	}

	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Score != rows[j].Score {
			return rows[i].Score > rows[j].Score
		}
		return rows[i].Number < rows[j].Number
	})

	// One row per physical train: hide a coupled twin behind the first.
	seen := make(map[string]struct{})
	out := make([]Suggestion, 0, limit)
	for _, r := range rows {
		if _, hidden := seen[r.Number]; hidden {
			continue
		}
		for _, n := range r.CoupledWith {
			seen[n] = struct{}{}
		}
		out = append(out, r)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// WorstBoard is the day's ranking, with the reasons where they are known.
type WorstBoard struct {
	Day              string      `json:"day"`
	ReasonsAvailable bool        `json:"reasonsAvailable"`
	Trains           []board.Row `json:"trains"`
}

// Worst returns the day's worst delays.
func (s *Store) Worst(limit int) WorstBoard {
	s.mu.RLock()
	live := make(map[string]struct{}, len(s.trains))
	for _, t := range s.trains {
		live[t.Number] = struct{}{}
	}
	s.mu.RUnlock()

	isLive := func(n string) bool {
		_, ok := live[n]
		return ok
	}
	return WorstBoard{
		Day:              s.board.Day(),
		ReasonsAvailable: s.disruptions.Enabled(),
		Trains:           s.board.Top(limit, isLive, s.disruptions.Reason, time.Now().Unix()),
	}
}

// Feature is one GeoJSON feature of a journey.
type Feature struct {
	Type       string         `json:"type"`
	Geometry   map[string]any `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

// Journey is a train's route as GeoJSON.
type Journey struct {
	Type     string    `json:"type"`
	Features []Feature `json:"features"`
}

// JourneyGeo builds a train's route, with one motion profile per leg.
//
// The profile is why the map can place the train continuously without re-deriving
// anything: the server samples it here, once per routed leg, and the browser only
// interpolates it. Four decimals is a ten-thousandth of a leg — centimetres on the
// longest of them — and it keeps the payload to a few kilobytes.
func (s *Store) JourneyGeo(dto TrainDTO) Journey {
	s.mu.RLock()
	defer s.mu.RUnlock()

	coords := make([][2]float64, 0, 512)
	profiles := make([][]float64, 0, len(dto.Calls))
	covered, total := 0, 0

	for i := 0; i+1 < len(dto.Calls); i++ {
		a, b := dto.Calls[i], dto.Calls[i+1]
		total++
		leg := s.pathFor(a.Lat, a.Lon, b.Lat, b.Lon)
		if leg == nil {
			coords = append(coords, [2]float64{a.Lon, a.Lat}, [2]float64{b.Lon, b.Lat})
			profiles = append(profiles, []float64{})
			continue
		}
		covered++
		for _, p := range leg.Pts {
			if n := len(coords); n > 0 && coords[n-1][0] == p[1] && coords[n-1][1] == p[0] {
				continue
			}
			coords = append(coords, [2]float64{p[1], p[0]})
		}
		rounded := motion.SampleProfile(leg.Cum, leg.CumT)
		for j, v := range rounded {
			rounded[j] = math.Round(v*1e4) / 1e4
		}
		profiles = append(profiles, rounded)
	}

	features := make([]Feature, 0, len(dto.Calls)+1)
	features = append(features, Feature{
		Type: "Feature",
		Geometry: map[string]any{
			"type":        "LineString",
			"coordinates": smoothRoute(coords),
		},
		Properties: map[string]any{
			"number":           dto.Number,
			"legsWithGeometry": covered,
			"legs":             total,
			"legProfiles":      profiles,
		},
	})
	for i, c := range dto.Calls {
		terminus := 0
		if i == len(dto.Calls)-1 {
			terminus = 1
		}
		features = append(features, Feature{
			Type:     "Feature",
			Geometry: map[string]any{"type": "Point", "coordinates": [2]float64{c.Lon, c.Lat}},
			Properties: map[string]any{
				"name": c.Name, "time": c.Time, "delay": c.Delay,
				"index": i, "terminus": terminus,
			},
		})
	}
	return Journey{Type: "FeatureCollection", Features: features}
}

// pathFor routes a leg, or returns nil where the graph cannot.
func (s *Store) pathFor(aLat, aLon, bLat, bLon float64) *rail.Path {
	if s.graph == nil {
		return nil
	}
	return s.graph.Path(s.paths, aLat, aLon, bLat, bLon, true)
}

// Stats is the feed's health, and what the process is holding.
type Stats struct {
	Total     int            `json:"total"`
	ByFamily  map[string]int `json:"byFamily"`
	Delayed   int            `json:"delayed"`
	Cancelled int            `json:"cancelled"`
	FeedTS    int64          `json:"feedTs"`
	FetchedAt int64          `json:"fetchedAt"`
	AgeSec    int64          `json:"ageSec"`
	Stale     bool           `json:"stale"`
	Replay    bool           `json:"replay"`
	Error     string         `json:"error,omitempty"`
	Memory    Memory         `json:"memory"`
}

// Memory is what the process is holding, and in what.
//
// The counters exist because the TypeScript process died on its heap ceiling on
// five separate days and each diagnosis was inference from a single total. They
// are cheap, and they turn "it grew" into "this grew".
type Memory struct {
	HeapMB   uint64   `json:"heapMb"`
	SysMB    uint64   `json:"sysMb"`
	Retained Retained `json:"retained"`
}

// Retained counts the structures that outlive one refresh.
type Retained struct {
	Trains         int `json:"trains"`
	History        int `json:"history"`
	HistorySamples int `json:"historySamples"`
	LastSeen       int `json:"lastSeen"`
	Board          int `json:"board"`
	Disruptions    int `json:"disruptions"`
	Coupling       int `json:"coupling"`
	Paths          int `json:"paths"`
	PathPoints     int `json:"pathPoints"`
	Signals        int `json:"signals"`
	GraphNodes     int `json:"graphNodes"`
	GraphEdges     int `json:"graphEdges"`
}

// staleAfter is when a reading is old enough to say so.
const staleAfter = 5 * time.Minute

// Stats reports the feed's health and what the process holds.
func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().Unix()
	st := Stats{
		Total:     len(s.trains),
		ByFamily:  map[string]int{},
		FeedTS:    s.feedTS,
		FetchedAt: s.fetchedAt,
		Replay:    s.replay,
		Error:     s.err,
	}
	if s.feedTS > 0 {
		st.AgeSec = now - s.feedTS
		st.Stale = time.Duration(st.AgeSec)*time.Second > staleAfter
	}
	for _, t := range s.trains {
		st.ByFamily[string(t.Family())]++
		if t.Cancelled {
			st.Cancelled++
		}
		if t.CurrentDelay(now) >= 300 {
			st.Delayed++
		}
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	samples := 0
	for _, h := range s.history {
		samples += len(h)
	}
	paths, points := s.paths.Stats()
	st.Memory = Memory{
		HeapMB: mem.HeapAlloc / 1e6,
		SysMB:  mem.Sys / 1e6,
		Retained: Retained{
			Trains: len(s.trains), History: len(s.history), HistorySamples: samples,
			LastSeen: len(s.lastSeen), Board: s.board.Size(),
			Disruptions: s.disruptions.Size(), Coupling: s.coupling.Size(),
			Paths: paths, PathPoints: points, Signals: s.signals.Size(),
			GraphNodes: s.graphNodes(), GraphEdges: s.graphEdges(),
		},
	}
	return st
}

func (s *Store) graphNodes() int {
	if s.graph == nil {
		return 0
	}
	return s.graph.NodeCount()
}

func (s *Store) graphEdges() int {
	if s.graph == nil {
		return 0
	}
	return s.graph.EdgeCount()
}

// FeedTS is when the current reading was published.
func (s *Store) FeedTS() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.feedTS
}

// Stations exposes the static schedule, for the routes that search it.
func (s *Store) Stations() *gtfs.Static {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.statics
}
