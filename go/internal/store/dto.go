package store

import (
	"strings"
	"time"

	"traincon/internal/coupling"
	"traincon/internal/feed"
	"traincon/internal/gtfs"
	"traincon/internal/headway"
	"traincon/internal/train"
)

// TrainDTO is a train as the API serves it.
type TrainDTO struct {
	ID           string      `json:"id"`
	Number       string      `json:"number"`
	// Service is the marker the static schedule carries, or null where it
	// knows none — which the client distinguishes from an empty label.
	Service      *string     `json:"service"`
	ServiceLabel string      `json:"serviceLabel"`
	Family       gtfs.Family `json:"family"`
	Line         string      `json:"line"`
	Origin       string      `json:"origin"`
	Destination  string      `json:"destination"`
	Calls        []feed.Call `json:"calls"`
	Cancelled    bool        `json:"cancelled"`
	// Delay is the reconciled figure; OwnDelay is this number's own, before a
	// coupled twin's fresher record was applied.
	Delay       int64                    `json:"delay"`
	OwnDelay    int64                    `json:"ownDelay"`
	WorstDelay  int64                    `json:"worstDelay"`
	Position    train.Position           `json:"position"`
	Next        *NextCall                `json:"next"`
	Trend       Trend                    `json:"trend"`
	History     []DelaySample            `json:"history"`
	CoupledWith []string                 `json:"coupledWith"`
	Reconciled  *coupling.Reconciliation `json:"reconciled"`
	Traffic     *headway.Traffic         `json:"traffic"`
	FeedTS      int64                    `json:"feedTs"`
}

// NextCall is the next stop a train has yet to make.
type NextCall struct {
	Name  string `json:"name"`
	Time  int64  `json:"time"`
	Delay int64  `json:"delay"`
}

// LightDTO is the same train in the shape the map asks for.
//
// This was once a projection applied after building a full DTO per train —
// every call array and every delay sample assembled, then dropped on the way
// out. These fields are all it ever wanted.
type LightDTO struct {
	Number      string            `json:"number"`
	Service     string            `json:"service"`
	Family      gtfs.Family       `json:"family"`
	Origin      string            `json:"origin"`
	Destination string            `json:"destination"`
	Delay       int64             `json:"delay"`
	Cancelled   bool              `json:"cancelled"`
	Trend       Trend             `json:"trend"`
	CoupledWith []string          `json:"coupledWith"`
	Lat         float64           `json:"lat"`
	Lon         float64           `json:"lon"`
	Bearing     float64           `json:"bearing"`
	Basis       train.Basis       `json:"basis"`
	SpeedKmh    float64           `json:"speedKmh"`
	Geometry    string            `json:"geometry"`
	Quality     train.Quality     `json:"quality"`
	Observation train.Observation `json:"observation"`
	LegKm       *float64          `json:"legKm,omitempty"`
	FromStop    string            `json:"fromStop,omitempty"`
	Next        *NextCall         `json:"next"`
}

// Filter narrows a listing.
type Filter struct {
	Family   gtfs.Family
	MinDelay int64
	Running  bool
	Query    string
}

// view is a train's cheap fields, worked out once and shared by both list
// builders.
//
// Deliberately stops short of the position, which is the expensive part: it
// routes the leg over the rail graph. A filtered list can decide what to drop
// from these fields alone, and pay for the positions of only what survives.
type view struct {
	// train is the service as the feed gave it: OwnDelay is measured on this.
	train *train.Train
	meta  gtfs.ServiceMeta
	rec   *coupling.Reconciliation
	// corrected is the same train carrying a coupled partner's fresher calls,
	// where there is one.
	corrected *train.Train
	delay     int64
}

// viewOf works out what can be known without routing.
func (s *Store) viewOf(t *train.Train, now int64) view {
	v := view{train: t, meta: gtfs.Service(t.Service), corrected: t}
	if rec, ok := s.couples.Delays[t.Number]; ok {
		v.rec = &rec
	}
	if calls, ok := s.couples.Calls[t.Number]; ok {
		v.corrected = t.WithCalls(calls)
	}
	if v.rec != nil {
		v.delay = v.rec.Delay
	} else {
		v.delay = v.corrected.CurrentDelay(now)
	}
	return v
}

// selected returns the trains matching everything in the filter that can be
// judged without a position, so the ones that fail are never routed.
//
// Running is not among them: it reads the position's basis, so it has to wait
// until the position exists.
func (s *Store) selected(f Filter, now int64) []view {
	q := strings.ToLower(f.Query)
	out := make([]view, 0, len(s.trains))
	for _, t := range s.trains {
		v := s.viewOf(t, now)
		if f.Family != "" && v.meta.Family != f.Family {
			continue
		}
		if f.MinDelay != 0 && v.delay < f.MinDelay {
			continue
		}
		if q != "" && !matches(v.corrected, q) {
			continue
		}
		out = append(out, v)
	}
	return out
}

// matches reports whether a train answers a free-text search.
func matches(t *train.Train, q string) bool {
	if strings.Contains(t.Number, q) ||
		strings.Contains(strings.ToLower(t.Origin()), q) ||
		strings.Contains(strings.ToLower(t.Destination()), q) {
		return true
	}
	for _, c := range t.Calls {
		if strings.Contains(strings.ToLower(c.Name), q) {
			return true
		}
	}
	return false
}

// trend is which way a delay has moved over the retained history.
func (s *Store) trend(number string) Trend {
	h := s.history[number]
	if len(h) < 2 {
		return Stable
	}
	switch d := h[len(h)-1].Delay - h[0].Delay; {
	case d >= 120:
		return Worsening
	case d <= -120:
		return Recovering
	default:
		return Stable
	}
}

func nextCallOf(t *train.Train, now int64) *NextCall {
	c, ok := t.NextCall(now)
	if !ok {
		return nil
	}
	return &NextCall{Name: c.Name, Time: c.Time, Delay: c.Delay}
}

// toDTO turns a train into the shape the API serves.
func (s *Store) toDTO(v view, now int64) TrainDTO {
	t, c := v.train, v.corrected
	var service *string
	if c.Service != "" {
		service = &c.Service
	}
	dto := TrainDTO{
		ID: c.ID, Number: c.Number, Service: service,
		ServiceLabel: v.meta.Label, Family: v.meta.Family, Line: c.Line,
		Origin: c.Origin(), Destination: c.Destination(), Calls: c.Calls,
		Cancelled: c.Cancelled,
		Delay:     v.delay,
		// OwnDelay comes from the uncorrected train, which is the whole point
		// of keeping both.
		OwnDelay:    t.CurrentDelay(now),
		WorstDelay:  t.WorstDelay(),
		Next:        nextCallOf(c, now),
		Trend:       s.trend(t.Number),
		History:     s.history[t.Number],
		CoupledWith: s.couples.Partners[t.Number],
		Reconciled:  v.rec,
		FeedTS:      c.FeedTS,
	}
	if dto.CoupledWith == nil {
		dto.CoupledWith = []string{}
	}
	if dto.History == nil {
		dto.History = []DelaySample{}
	}
	if pos, ok := s.couples.Positions[t.Number]; ok {
		dto.Position = pos
	} else {
		dto.Position = c.PositionAt(now, s.graph, s.paths)
	}
	if tr, ok := s.traffic[t.Number]; ok {
		dto.Traffic = &tr
	}
	return dto
}

// List returns the trains matching a filter, in full.
func (s *Store) List(f Filter) []TrainDTO {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().Unix()
	out := make([]TrainDTO, 0, len(s.trains))
	for _, v := range s.selected(f, now) {
		dto := s.toDTO(v, now)
		if f.Running && dto.Position.Basis != train.Between && dto.Position.Basis != train.AtStation {
			continue
		}
		out = append(out, dto)
	}
	return out
}

// LightList returns the same trains in the shape the map asks for.
func (s *Store) LightList(f Filter) []LightDTO {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().Unix()
	out := make([]LightDTO, 0, len(s.trains))
	for _, v := range s.selected(f, now) {
		c := v.corrected
		pos, ok := s.couples.Positions[v.train.Number]
		if !ok {
			pos = c.PositionAt(now, s.graph, s.paths)
		}
		if f.Running && pos.Basis != train.Between && pos.Basis != train.AtStation {
			continue
		}
		partners := s.couples.Partners[v.train.Number]
		if partners == nil {
			partners = []string{}
		}
		out = append(out, LightDTO{
			Number: c.Number, Service: v.meta.Label, Family: v.meta.Family,
			Origin: c.Origin(), Destination: c.Destination(),
			Delay: v.delay, Cancelled: c.Cancelled,
			Trend: s.trend(v.train.Number), CoupledWith: partners,
			Lat: pos.Lat, Lon: pos.Lon, Bearing: pos.Bearing, Basis: pos.Basis,
			SpeedKmh: pos.SpeedKmh, Geometry: pos.Geometry,
			Quality: pos.Quality, Observation: pos.Observation,
			LegKm: pos.LegKm, FromStop: pos.FromStop,
			Next: nextCallOf(c, now),
		})
	}
	return out
}

// Find returns every record carrying a train number. There is normally one, but
// a number can appear twice when a service is split.
func (s *Store) Find(number string) []TrainDTO {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().Unix()
	var out []TrainDTO
	for _, t := range s.byNumber[number] {
		out = append(out, s.toDTO(s.viewOf(t, now), now))
	}
	return out
}

// KnownSchedule reports what the static timetable knows about a number that is
// not in the live feed, so a dormant train can be told from an unknown one.
func (s *Store) KnownSchedule(number string) (gtfs.TrainMeta, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, meta := range s.statics.Trains {
		if meta.Number == number {
			return meta, true
		}
	}
	return gtfs.TrainMeta{}, false
}
