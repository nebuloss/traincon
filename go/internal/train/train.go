package train

import (
	"math"
	"time"

	"traincon/internal/feed"
	"traincon/internal/geo"
	"traincon/internal/gtfs"
	"traincon/internal/rail"
)

// Basis says what kind of answer a position is.
type Basis string

// The states a train can be in, from the timetable alone.
const (
	NotDeparted Basis = "not_departed"
	AtStation   Basis = "at_station"
	Between     Basis = "between"
	Arrived     Basis = "arrived"
	UnknownLeg  Basis = "unknown"
)

// Confidence grades how recently the estimate was anchored on an observation.
type Confidence string

// The confidence bands, by how long ago the train was last seen at a stop.
const (
	Confirmed Confidence = "confirmed"
	Good      Confidence = "good"
	Estimated Confidence = "estimated"
	Stale     Confidence = "stale"
	Scheduled Confidence = "scheduled"
)

// Train is one service, and everything derivable from its calls.
type Train struct {
	ID        string
	Number    string
	Service   string
	Line      string
	Calls     []feed.Call
	Cancelled bool
	FeedTS    int64
}

// FromFeed adopts a decoded feed entry.
func FromFeed(t feed.Train) *Train {
	return &Train{
		ID: t.ID, Number: t.Number, Service: t.Service, Line: t.Line,
		Calls: t.Calls, Cancelled: t.Cancelled, FeedTS: t.FeedTS,
	}
}

// Origin, Destination and Terminus name the ends of the journey.
func (t *Train) Origin() string      { return t.Calls[0].Name }
func (t *Train) Destination() string { return t.Terminus().Name }
func (t *Train) Terminus() feed.Call { return t.Calls[len(t.Calls)-1] }

// Meta is how the service presents itself.
func (t *Train) Meta() gtfs.ServiceMeta { return gtfs.Service(t.Service) }

// Family is the kind of stock, which decides speed ceilings and LGV access.
func (t *Train) Family() gtfs.Family { return t.Meta().Family }

// WorstDelay is the worst figure anywhere on the run, including stops already
// behind the train.
func (t *Train) WorstDelay() int64 {
	worst := int64(math.MinInt64)
	for _, c := range t.Calls {
		if c.Delay > worst {
			worst = c.Delay
		}
	}
	return worst
}

// WithCalls returns a copy carrying different calls, for when a coupled twin's
// record is fresher than this one's.
func (t *Train) WithCalls(calls []feed.Call) *Train {
	clone := *t
	clone.Calls = calls
	return &clone
}

// NextCall is the next call the train has yet to make, or false at the end of
// the journey.
func (t *Train) NextCall(now int64) (feed.Call, bool) {
	for _, c := range t.Calls {
		if c.Time > now {
			return c, true
		}
	}
	return feed.Call{}, false
}

// CurrentDelay is the delay that actually matters: the one still ahead.
//
// WorstDelay is the worst figure anywhere on the journey, including stops
// already behind the train — so a service that lost 70 minutes early on and has
// since clawed back 20 still reads +70. That is what made this app show +70 for
// 8582 while SNCF Connect showed +50: by Bordeaux the train really was only 50
// late.
func (t *Train) CurrentDelay(now int64) int64 {
	if c, ok := t.NextCall(now); ok {
		return c.Delay
	}
	return t.Terminus().Delay
}

// Leg is which part of the journey the train is on, from the timetable alone.
type Leg struct {
	Basis Basis
	A, B  feed.Call
	// F is the fraction along the leg, 0..1.
	F float64
	// I is the index of A within the calls.
	I int
	// Span is the leg's duration in seconds, when running.
	Span int64
}

// LegAt says which leg the train is on. Pure timetable logic, no geometry;
// every time used here is SNCF's own live forecast.
func (t *Train) LegAt(now int64) Leg {
	calls := t.Calls
	first, last := calls[0], calls[len(calls)-1]

	if now < first.Time {
		b := first
		if len(calls) > 1 {
			b = calls[1]
		}
		return Leg{Basis: NotDeparted, A: first, B: b, F: 0, I: 0}
	}
	if now >= last.Time {
		a := last
		if len(calls) > 1 {
			a = calls[len(calls)-2]
		}
		return Leg{Basis: Arrived, A: a, B: last, F: 1, I: len(calls) - 2}
	}

	for i := 0; i < len(calls)-1; i++ {
		a, b := calls[i], calls[i+1]
		depA := a.Time
		if a.HasDeparture {
			depA = a.Departure
		}
		// Dwelling: arrival passed but departure still ahead. Checked before
		// the between-stations case so a train at a platform is placed on it.
		if a.HasArrival && now >= a.Arrival && now < depA {
			return Leg{Basis: AtStation, A: a, B: b, F: 0, I: i}
		}
		arrB := b.Time
		if b.HasArrival {
			arrB = b.Arrival
		}
		if now >= depA && now < arrB {
			span := arrB - depA
			var f float64
			if span > 0 {
				f = float64(now-depA) / float64(span)
			}
			return Leg{Basis: Between, A: a, B: b, F: f, I: i, Span: span}
		}
	}
	return Leg{Basis: UnknownLeg, A: last, B: last, F: 1, I: len(calls) - 2}
}

// Observation is how much ground truth is behind the current estimate.
//
// GTFS-RT only revises a train when it is observed, which in practice means
// when it calls at a stop. On a leg with no intermediate stop the published
// delay is simply carried forward, so a train that recovers or loses time
// mid-leg is invisible until it arrives.
type Observation struct {
	LastStop     string     `json:"lastStop"`
	LastStopTime int64      `json:"lastStopTime,omitempty"`
	AgeSec       *int64     `json:"ageSec"`
	LegSec       *int64     `json:"legSec"`
	Confidence   Confidence `json:"confidence"`
}

// ObservationAt grades the estimate behind the train's current position.
func (t *Train) ObservationAt(now int64) Observation {
	var last *feed.Call
	for i := range t.Calls {
		if t.Calls[i].Time <= now {
			last = &t.Calls[i]
		}
	}
	if last == nil {
		return Observation{Confidence: Scheduled}
	}

	age := now - last.Time
	obs := Observation{LastStop: last.Name, LastStopTime: last.Time, AgeSec: &age}
	if next, ok := t.NextCall(now); ok {
		leg := next.Time - last.Time
		obs.LegSec = &leg
	}
	// Long unobserved legs are where the published time drifts furthest from
	// reality; short hops re-anchor every few minutes.
	switch {
	case age < 120:
		obs.Confidence = Confirmed
	case age < 20*60:
		obs.Confidence = Good
	case age < 45*60:
		obs.Confidence = Estimated
	default:
		obs.Confidence = Stale
	}
	return obs
}

// Quality states plainly what a position is worth. Never claim more.
type Quality struct {
	Method     string     `json:"method"`
	Confidence Confidence `json:"confidence"`
	Note       string     `json:"note"`
}

// Position is where a train is, and how well that is known.
type Position struct {
	Basis       Basis       `json:"basis"`
	Lat         float64     `json:"lat"`
	Lon         float64     `json:"lon"`
	Bearing     float64     `json:"bearing"`
	Progress    float64     `json:"progress"`
	LegProgress *float64    `json:"legProgress,omitempty"`
	FromStop    string      `json:"fromStop,omitempty"`
	AtStation   string      `json:"atStation,omitempty"`
	NextStop    *string     `json:"nextStop"`
	LegKm       *float64    `json:"legKm,omitempty"`
	DistKm      *float64    `json:"distKm,omitempty"`
	SpeedKmh    float64     `json:"speedKmh"`
	// AvgKmh is present only where the leg was routed: a straight-line
	// fallback has no track distance to average over.
	AvgKmh      *float64    `json:"avgKmh,omitempty"`
	LimitKmh    *float64    `json:"limitKmh,omitempty"`
	Geometry    string      `json:"geometry"`
	Observation Observation `json:"observation"`
	Quality     Quality     `json:"quality"`
}

// PositionAt says where the train is.
//
// With a graph the point is projected onto real track and the bearing follows
// the actual curve; without one it falls back to a great circle. Only a
// high-speed train may be routed over a high-speed line.
func (t *Train) PositionAt(now int64, g *rail.Graph, cache *rail.Cache) Position {
	leg := t.LegAt(now)
	obs := t.ObservationAt(now)

	legF := 0.0
	if leg.Basis == Between {
		legF = leg.F
	}
	// Legs completed, over legs there are. The TypeScript divides the leg index
	// alone, which leaves an arrived train reporting half its journey done on a
	// three-stop run and none of it on a two-stop one. Nothing on the client
	// reads this field, so correcting it costs nothing and stops the payload
	// saying something untrue.
	legs := math.Max(1, float64(len(t.Calls)-1))
	done := float64(leg.I) + legF
	if leg.Basis == Arrived {
		done = legs
	}
	pos := Position{
		Basis:       leg.Basis,
		Progress:    done / legs,
		Observation: obs,
	}
	switch leg.Basis {
	case Between:
		pos.FromStop = leg.A.Name
		pos.LegProgress = &leg.F
	case Arrived:
		pos.AtStation = leg.B.Name
	default:
		pos.AtStation = leg.A.Name
	}
	if leg.Basis != Arrived {
		next := leg.B.Name
		pos.NextStop = &next
	}

	var path *rail.Path
	if g != nil {
		path = g.Path(cache, leg.A.Lat, leg.A.Lon, leg.B.Lat, leg.B.Lon, t.Family() == gtfs.FamilyTGV)
	}
	if path != nil {
		t.fillFromPath(&pos, path, leg, obs)
		return pos
	}
	t.fillFromGreatCircle(&pos, leg, obs)
	return pos
}

func (t *Train) fillFromPath(pos *Position, path *rail.Path, leg Leg, obs Observation) {
	f := leg.F
	if leg.Basis == Arrived {
		f = 1
	}
	pt := path.At(f)
	legHours := float64(leg.Span) / 3600

	// The line-speed profile gives the shape of the run; the timetable gives
	// its duration. Scaling one onto the other turns a nominal line speed into
	// the speed this train is actually managing.
	if leg.Basis == Between && legHours > 0 {
		scaled := path.Total / legHours
		if pt.NominalHours > 0 && pt.HasModelKmh {
			scaled = pt.ModelKmh * (pt.NominalHours / legHours)
		}
		pos.SpeedKmh = math.Round(PlausibleSpeed(scaled, t.Family(), pt.LimitKmh, pt.HasLimitKmh))
	}

	legKm := math.Round(path.Total*10) / 10
	distKm := math.Round(pt.DistKm*10) / 10
	pos.Lat, pos.Lon, pos.Bearing = pt.Lat, pt.Lon, pt.Bearing
	pos.LegKm, pos.DistKm = &legKm, &distKm
	avg := 0.0
	if legHours > 0 {
		avg = math.Round(PlausibleSpeed(path.Total/legHours, t.Family(), pt.LimitKmh, pt.HasLimitKmh))
	}
	pos.AvgKmh = &avg
	if pt.HasLimitKmh {
		limit := pt.LimitKmh
		pos.LimitKmh = &limit
	}
	pos.Geometry = "rail"
	pos.Quality = Quality{
		Method:     "rail_graph_speed_profile",
		Confidence: obs.Confidence,
		Note:       "projected onto the track using the line speed profile; SNCF real-time schedule, position not measured",
	}
}

func (t *Train) fillFromGreatCircle(pos *Position, leg Leg, obs Observation) {
	a := geo.Point{Lat: leg.A.Lat, Lon: leg.A.Lon}
	b := geo.Point{Lat: leg.B.Lat, Lon: leg.B.Lon}

	at := a
	switch leg.Basis {
	case Arrived:
		at = b
	case Between:
		at = geo.GreatCircle(a, b, leg.F)
	}

	legKm := geo.Haversine(a, b)
	rounded := math.Round(legKm)
	pos.Lat, pos.Lon, pos.Bearing = at.Lat, at.Lon, geo.Bearing(a, b)
	pos.LegKm = &rounded
	if leg.Basis == Between && leg.Span > 0 {
		kmh := legKm / float64(leg.Span) * 3600
		pos.SpeedKmh = math.Round(PlausibleSpeed(kmh, t.Family(), 0, false))
	}
	pos.Geometry = "direct"
	pos.Quality = Quality{
		Method:     "great_circle",
		Confidence: obs.Confidence,
		Note:       "no track geometry for this section; straight line between stations",
	}
}

// Now is the clock the store and its tests share, in epoch seconds.
func Now() int64 { return time.Now().Unix() }
