package store

import (
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"traincon/internal/feed"
	"traincon/internal/geo"
	"traincon/internal/train"
)

// snapshot is the last good reading, kept so a restart during a feed outage has
// something to serve rather than an empty map.
type snapshot struct {
	FeedTS  int64        `json:"feedTs"`
	SavedAt int64        `json:"savedAt"`
	Trains  []feed.Train `json:"trains"`
}

// saveSnapshot writes the current reading to disk.
//
// Replayed data is never written: demo trains must not become the thing a
// restart resumes from.
func (s *Store) saveSnapshot() {
	s.mu.RLock()
	if len(s.trains) == 0 || s.replay {
		s.mu.RUnlock()
		return
	}
	snap := snapshot{FeedTS: s.feedTS, SavedAt: time.Now().UnixMilli()}
	snap.Trains = make([]feed.Train, 0, len(s.trains))
	for _, t := range s.trains {
		snap.Trains = append(snap.Trains, feed.Train{
			ID: t.ID, Number: t.Number, Service: t.Service, Line: t.Line,
			Origin: t.Origin(), Destination: t.Destination(),
			Calls: t.Calls, Cancelled: t.Cancelled,
			MaxDelay: t.WorstDelay(), LastDelay: t.Terminus().Delay, FeedTS: t.FeedTS,
		})
	}
	file := s.snapshotFile()
	s.mu.RUnlock()

	body, err := json.Marshal(snap)
	if err != nil {
		slog.Warn("snapshot: could not be encoded", "err", err)
		return
	}
	if err := os.WriteFile(file, body, 0o644); err != nil {
		slog.Warn("snapshot: could not be written", "err", err)
	}
}

// loadSnapshot restores the last good reading, returning how many trains it
// found. A missing or unreadable file is simply nothing to resume from.
func (s *Store) loadSnapshot() int {
	body, err := os.ReadFile(s.snapshotFile())
	if err != nil {
		return 0
	}
	var snap snapshot
	if err := json.Unmarshal(body, &snap); err != nil || len(snap.Trains) == 0 {
		return 0
	}

	trains := make([]*train.Train, 0, len(snap.Trains))
	byNumber := make(map[string][]*train.Train, len(snap.Trains))
	for _, raw := range snap.Trains {
		t := train.FromFeed(raw)
		trains = append(trains, t)
		byNumber[t.Number] = append(byNumber[t.Number], t)
	}

	couples := s.coupling.Detect(trains, time.Now().Unix(), s.graph, s.paths)

	s.mu.Lock()
	s.trains, s.byNumber, s.couples = trains, byNumber, couples
	s.feedTS, s.fetchedAt = snap.FeedTS, snap.SavedAt
	s.mu.Unlock()
	return len(trains)
}

// legMidpoint places a train along its current leg on a straight line, which is
// all the spacing analysis needs: it groups by proximity and heading, and
// routing every train for that would cost more than the answer is worth.
func legMidpoint(t *train.Train, leg train.Leg) train.Position {
	a := geo.Point{Lat: leg.A.Lat, Lon: leg.A.Lon}
	b := geo.Point{Lat: leg.B.Lat, Lon: leg.B.Lon}
	span := max(1.0, float64(leg.Span)/3600)

	return train.Position{
		Basis:    train.Between,
		Lat:      a.Lat + (b.Lat-a.Lat)*leg.F,
		Lon:      a.Lon + (b.Lon-a.Lon)*leg.F,
		Bearing:  geo.Bearing(a, b),
		Progress: (float64(leg.I) + leg.F) / max(1, float64(len(t.Calls)-1)),
		SpeedKmh: geo.Haversine(a, b) / span,
	}
}
