// Package headway keeps a following train from being drawn on top of the one
// ahead.
//
// The position estimate places each train independently, from its own timetable
// and its own delay. Nothing in that stops two of them occupying the same piece
// of track: a fast train catching a slower one is simply drawn closing the gap
// and then sitting on it, when in reality it would have been held a block short
// and slowed. It is a regular sight on a busy two-track stretch — Bordeaux to
// Dax is the example that prompted this.
//
// So after positions are computed, trains sharing a line and a direction are put
// in order and any follower closer than one block is pushed back to it, with its
// speed cut to match. That is a correction to the drawing, not a claim about the
// signals: it says "this train cannot be here, because that one is", which is
// true regardless of where the signals stand.
//
// Deliberately conservative. It acts only on trains demonstrably on the same
// line heading the same way, and it only ever moves a train backwards — never
// forwards, which would be inventing progress.
package headway

import (
	"math"

	"traincon/internal/geo"
	"traincon/internal/train"
)

// Aspect is the signal a driver would be reading, deduced from the traffic
// ahead.
//
// Not observed. SNCF publishes neither signal positions nor their states, so
// nothing here reports a real aspect — it is what French block working implies
// given how far ahead the next train is, and it must be labelled as deduced
// wherever it is shown.
type Aspect string

// The aspects, as French block working defines them.
const (
	// Libre: nothing close ahead — voie libre.
	Libre Aspect = "libre"
	// Avertissement: one block clear, the next signal at danger — slow and
	// prepare to stop.
	Avertissement Aspect = "avertissement"
	// Semaphore: the block ahead is occupied — stop, then proceed at caution.
	Semaphore Aspect = "semaphore"
	// Inconnu: no train ahead identified, so nothing can be said.
	Inconnu Aspect = "inconnu"
)

// brakeMS2 is service braking — the same figure the line-speed profile uses,
// because it is the same train doing the same thing.
const brakeMS2 = 0.5

// sameTrainM is the gap below which two "trains" are one train, whatever the
// feed says.
//
// No signalling system puts two trains at the same point, so a gap of nothing is
// a data artefact rather than a following move. It happens for coupled sets, and
// for portions that run joined and split later — which the coupling detector
// misses because it buckets on a shared terminus and those share an origin
// instead: 5500 to Metz and 12184 to Strasbourg leave Montpellier at the same
// second, joined, and were drawn as one running into the other.
const sameTrainM = 150

const (
	// sameWayDeg is the heading difference within which two trains count as
	// going the same way.
	sameWayDeg = 60
	// neighbourKm is the distance beyond which trains are simply elsewhere on a
	// long line.
	neighbourKm = 40
)

// Follower is what the analysis needs to know about a train.
type Follower struct {
	Number string
	// Line is the line identifier, as published in the timetable.
	Line     string
	Position train.Position
	// CoupledWith is the other numbers of this physical train, when it is a
	// coupled set.
	//
	// Two portions joined together are one train carrying two numbers, drawn at
	// the same point because they are in the same place. Without this they look
	// like one train sitting on another and one gets pushed a block back — seen
	// in production on 12177/5537, Strasbourg to Nice.
	CoupledWith []string
}

// Traffic is what the trains ahead imply for one train.
type Traffic struct {
	Aspect Aspect `json:"aspect"`
	// Ahead is the train identified in front, when there was one.
	Ahead string `json:"ahead,omitempty"`
	// GapM is the distance to it, metres.
	GapM *int `json:"gapM,omitempty"`
	// PushedM is how far this train was moved back to stay clear.
	PushedM *int `json:"pushedM,omitempty"`
	// SignalM is the distance to the next signal that could stop it, and
	// SignalKind which sort it is: a carré shows two reds, a sémaphore one.
	SignalM    *int   `json:"signalM,omitempty"`
	SignalKind string `json:"signalKind,omitempty"`
	// Opposing marks the other train as coming the other way on single track.
	//
	// Both are reported and neither is moved. One of them is waiting in a loop
	// for the other, and which one is not knowable from the timetable — saying
	// so is honest, guessing would put a train where it is not.
	Opposing bool `json:"opposing,omitempty"`
	// AllowedKmh is the speed the approach permits, present only when it is
	// actually a restriction. Absent means the traffic ahead is not
	// constraining this train, so its own speed stands.
	AllowedKmh *float64 `json:"allowedKmh,omitempty"`
}

// Signal is the next signal that can stop a train, when the signalling layer
// knows of one.
type Signal struct {
	M    float64
	Kind string
}

// Layout is the track arrangement at a point.
type Layout struct {
	Single bool
	Tracks int
}

// SpacingFunc gives the minimum spacing at a point, in metres, from the block
// working mode in force there.
type SpacingFunc func(lat, lon float64) float64

// SignalFunc gives the distance to the next signal that can stop a train, when
// the signalling layer is loaded. Real geometry beats the block-length estimate:
// it is where the train would actually be brought to a stand, rather than an
// average for that kind of line.
type SignalFunc func(lat, lon, bearing float64) (Signal, bool)

// LayoutFunc gives the track layout at a point. On single track a train is
// constrained by everything on the line, not merely by what is in front of it.
type LayoutFunc func(lat, lon float64) Layout

// ApproachSpeed is the speed a train may be doing this far from something it
// must pass at targetKmh.
//
// The parabolic law, v² = 2·a·d, which is what a constant deceleration gives: to
// stop in d metres at a m/s² you may be doing no more than sqrt(2·a·d) now.
// Approaching a signal at danger 1 800 m away, that is 42 m/s, about 150 km/h.
//
// The same expression covers coming off a restriction, because as the train
// ahead pulls away d grows and the permitted speed grows with it — a square
// root, so quickly at first and then gently, which is what letting a train back
// up to line speed looks like.
func ApproachSpeed(distanceM, freeKmh, targetKmh float64) float64 {
	if distanceM <= 0 {
		return math.Min(freeKmh, targetKmh)
	}
	target := math.Max(0, targetKmh) / 3.6
	allowed := math.Sqrt(target*target+2*brakeMS2*distanceM) * 3.6
	// Never faster than it was going to go anyway: a signal can restrain a
	// train, never licence it to exceed the line speed or its own timetable.
	return math.Min(freeKmh, allowed)
}

// headingGap is the smallest angle between two headings, in degrees.
func headingGap(a, b float64) float64 {
	d := math.Mod(math.Abs(a-b), 360)
	if d > 180 {
		return 360 - d
	}
	return d
}

// Analyse works out which trains are running into the back of which.
//
// It returns only what each train's traffic implies; the caller applies any
// change, so this stays a pure function of the snapshot. spacingM is required;
// nextSignal and layoutAt may be nil when those layers are not loaded.
func Analyse(trains []Follower, spacingM SpacingFunc, nextSignal SignalFunc, layoutAt LayoutFunc) map[string]Traffic {
	out := make(map[string]Traffic)

	// Only trains actually running between stops are constrained: one standing
	// in a station is where the timetable says it is, and one that has arrived
	// is done.
	byLine := make(map[string][]Follower)
	for _, t := range trains {
		if t.Position.Basis == train.Between && t.Line != "" {
			byLine[t.Line] = append(byLine[t.Line], t)
		}
	}

	for _, group := range byLine {
		for _, a := range group {
			pa := a.Position
			blockKm := spacingM(pa.Lat, pa.Lon) / 1000

			// On single track, a train coming the other way is a harder
			// constraint than one in front: they cannot pass at all, so one is
			// standing in a loop. Checked first, because it outranks following.
			if layoutAt != nil && layoutAt(pa.Lat, pa.Lon).Single {
				if t, ok := opposingTraffic(a, group, blockKm); ok {
					out[a.Number] = t
					continue
				}
			}

			ahead, gapKm, found := nearestAhead(a, group)
			if !found || blockKm <= 0 {
				// No train ahead, or no block working to enforce. Calling a
				// line clear whose signalling we cannot model would be a claim
				// too far.
				aspect := Inconnu
				if blockKm > 0 {
					aspect = Libre
				}
				out[a.Number] = Traffic{Aspect: aspect}
				continue
			}
			out[a.Number] = following(pa, ahead, gapKm, blockKm, nextSignal)
		}
	}
	return out
}

// coupled reports whether two followers are portions of one physical train.
func coupled(a, b Follower) bool {
	for _, n := range a.CoupledWith {
		if n == b.Number {
			return true
		}
	}
	for _, n := range b.CoupledWith {
		if n == a.Number {
			return true
		}
	}
	return false
}

// opposingTraffic finds the nearest train coming the other way, on single track.
func opposingTraffic(a Follower, group []Follower, blockKm float64) (Traffic, bool) {
	pa := a.Position
	var facing Follower
	bestKm := math.Inf(1)
	for _, b := range group {
		if a.Number == b.Number || coupled(a, b) {
			continue
		}
		if headingGap(pa.Bearing, b.Position.Bearing) < 180-sameWayDeg {
			continue
		}
		gapKm := geo.HaversineAt(pa.Lat, pa.Lon, b.Position.Lat, b.Position.Lon)
		if gapKm > neighbourKm || gapKm*1000 < sameTrainM {
			continue
		}
		if gapKm < bestKm {
			bestKm, facing = gapKm, b
		}
	}
	if math.IsInf(bestKm, 1) || bestKm >= blockKm*2 {
		return Traffic{}, false
	}

	gapM := int(math.Round(bestKm * 1000))
	t := Traffic{Aspect: Semaphore, Ahead: facing.Number, GapM: &gapM, Opposing: true}
	// Brake for the midpoint: whichever of the two is moving must be able to
	// stop before meeting the other.
	if free := pa.SpeedKmh; free > 0 {
		if allowed := ApproachSpeed(bestKm/2*1000, free, 0); allowed < free-1 {
			rounded := math.Round(allowed)
			t.AllowedKmh = &rounded
		}
	}
	return t, true
}

// nearestAhead finds the closest train in front on the same line, going the
// same way.
func nearestAhead(a Follower, group []Follower) (Follower, float64, bool) {
	pa := a.Position
	var nearest Follower
	bestKm := math.Inf(1)
	for _, b := range group {
		if a.Number == b.Number || coupled(a, b) {
			continue
		}
		pb := b.Position
		if headingGap(pa.Bearing, pb.Bearing) > sameWayDeg {
			continue
		}
		if pb.Progress <= pa.Progress {
			continue
		}
		gapKm := geo.HaversineAt(pa.Lat, pa.Lon, pb.Lat, pb.Lon)
		if gapKm > neighbourKm || gapKm*1000 < sameTrainM {
			continue
		}
		if gapKm < bestKm {
			bestKm, nearest = gapKm, b
		}
	}
	if math.IsInf(bestKm, 1) {
		return Follower{}, 0, false
	}
	return nearest, bestKm, true
}

// following works out what the train ahead implies for the one behind it.
func following(pa train.Position, ahead Follower, gapKm, blockKm float64, nextSignal SignalFunc) Traffic {
	blocks := gapKm / blockKm

	// French block working, read off the distance in blocks: inside one, the
	// section ahead is occupied and the signal protecting it is at danger;
	// within two, the next signal is, so this one warns.
	aspect := Libre
	switch {
	case blocks < 1:
		aspect = Semaphore
	case blocks < 2:
		aspect = Avertissement
	}

	gapM := int(math.Round(gapKm * 1000))
	t := Traffic{Aspect: aspect, Ahead: ahead.Number, GapM: &gapM}

	// The signal it is running towards protects the occupied block. Where the
	// signalling is known, use the real one; otherwise fall back to the block
	// boundary, which is one block behind the train ahead.
	toRedM := (gapKm - blockKm) * 1000
	if nextSignal != nil {
		if real, ok := nextSignal(pa.Lat, pa.Lon, pa.Bearing); ok {
			toRedM = real.M
			m := int(math.Round(real.M))
			t.SignalM, t.SignalKind = &m, real.Kind
		}
	}
	if free := pa.SpeedKmh; free > 0 {
		// Only report it when it actually bites; otherwise the train is
		// unaffected and saying so would be noise.
		if allowed := ApproachSpeed(toRedM, free, 0); allowed < free-1 {
			rounded := math.Round(allowed)
			t.AllowedKmh = &rounded
		}
	}
	// Inside a block it cannot be where it is drawn; push it back to the
	// boundary. Only ever backwards — moving it forward would invent progress.
	if blocks < 1 {
		pushed := int(math.Round((blockKm - gapKm) * 1000))
		t.PushedM = &pushed
	}
	return t
}
