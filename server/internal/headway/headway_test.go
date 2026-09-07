package headway

import (
	"math"
	"testing"

	"traincon/internal/train"
)

// blocks of a fixed length, which is what an unsignalled estimate gives.
func fixedSpacing(m float64) SpacingFunc {
	return func(_, _ float64) float64 { return m }
}

// at builds a follower running north at a given point, speed and progress.
func at(number string, lat, lon, bearing, kmh, progress float64) Follower {
	return Follower{
		Number: number,
		Line:   "L",
		Position: train.Position{
			Basis:    train.Between,
			Lat:      lat,
			Lon:      lon,
			Bearing:  bearing,
			SpeedKmh: kmh,
			Progress: progress,
		},
	}
}

func TestApproachSpeed(t *testing.T) {
	tests := []struct {
		name      string
		distanceM float64
		freeKmh   float64
		targetKmh float64
		want      float64
		tolerance float64
	}{
		// The worked example from the rule: 1 800 m from a stop signal is
		// about 150 km/h.
		{"1800 m from a red", 1800, 300, 0, 150, 3},
		// Right on top of it, nothing is permitted.
		{"at the signal", 0, 300, 0, 0, 0.001},
		// A restriction rather than a stop: the target speed carries through.
		{"approaching a 100 restriction", 0, 300, 100, 100, 0.001},
		// Far enough away that the train's own speed is the binding limit.
		{"miles off", 100000, 160, 0, 160, 0.001},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ApproachSpeed(tc.distanceM, tc.freeKmh, tc.targetKmh)
			if math.Abs(got-tc.want) > tc.tolerance {
				t.Errorf("got %.1f km/h, want %.1f", got, tc.want)
			}
		})
	}
}

func TestApproachSpeedNeverLicencesGoingFaster(t *testing.T) {
	// A signal can restrain a train; it can never permit one to exceed the line
	// speed or its own timetable.
	for _, d := range []float64{0, 500, 5000, 50000} {
		if got := ApproachSpeed(d, 120, 0); got > 120 {
			t.Errorf("at %v m: %v km/h, above the free speed of 120", d, got)
		}
	}
}

func TestHeadingGap(t *testing.T) {
	tests := []struct{ a, b, want float64 }{
		{0, 0, 0},
		{0, 90, 90},
		{0, 180, 180},
		{10, 350, 20}, // across north
		{350, 10, 20}, // and back
		{0, 270, 90},  // the short way round
	}
	for _, tc := range tests {
		if got := headingGap(tc.a, tc.b); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("headingGap(%v,%v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestATrainWithNothingAheadRunsFree(t *testing.T) {
	got := Analyse([]Follower{at("1", 48, 2, 0, 160, 0.5)}, fixedSpacing(1500), nil, nil)
	if got["1"].Aspect != Libre {
		t.Errorf("aspect = %q, want libre", got["1"].Aspect)
	}
	if got["1"].Ahead != "" {
		t.Errorf("named %q ahead, but there is nothing there", got["1"].Ahead)
	}
}

func TestWithoutBlockWorkingNothingIsClaimed(t *testing.T) {
	// Calling a line clear whose signalling cannot be modelled would be a claim
	// too far.
	got := Analyse([]Follower{at("1", 48, 2, 0, 160, 0.5)}, fixedSpacing(0), nil, nil)
	if got["1"].Aspect != Inconnu {
		t.Errorf("aspect = %q, want inconnu", got["1"].Aspect)
	}
}

func TestAFollowerInsideABlockIsHeldBack(t *testing.T) {
	// Two trains 500 m apart on 1 500 m blocks: the follower is inside the
	// block ahead, so it is at a sémaphore and must be pushed back to the
	// boundary.
	const gapKm = 0.5
	trains := []Follower{
		at("behind", 48.0, 2.0, 0, 160, 0.4),
		at("ahead", 48.0+gapKm/111, 2.0, 0, 120, 0.6),
	}
	got := Analyse(trains, fixedSpacing(1500), nil, nil)

	held := got["behind"]
	if held.Aspect != Semaphore {
		t.Errorf("aspect = %q, want semaphore", held.Aspect)
	}
	if held.Ahead != "ahead" {
		t.Errorf("ahead = %q, want the train in front", held.Ahead)
	}
	if held.PushedM == nil || *held.PushedM <= 0 {
		t.Error("the follower was not pushed back out of the occupied block")
	}
	if held.AllowedKmh == nil || *held.AllowedKmh >= 160 {
		t.Errorf("allowed speed = %v, want a restriction below 160", held.AllowedKmh)
	}
	// The train in front is unconstrained.
	if got["ahead"].Aspect != Libre {
		t.Errorf("the leading train got %q, want libre", got["ahead"].Aspect)
	}
}

func TestAFollowerOneBlockBackSeesAWarning(t *testing.T) {
	// Between one and two blocks: the next signal is at danger, so this one
	// warns rather than stops.
	const gapKm = 2.0 // between 1 and 2 blocks of 1.5 km
	trains := []Follower{
		at("behind", 48.0, 2.0, 0, 160, 0.4),
		at("ahead", 48.0+gapKm/111, 2.0, 0, 120, 0.6),
	}
	got := Analyse(trains, fixedSpacing(1500), nil, nil)
	if got["behind"].Aspect != Avertissement {
		t.Errorf("aspect = %q, want avertissement", got["behind"].Aspect)
	}
	if got["behind"].PushedM != nil {
		t.Error("a train a full block back was pushed, but it is where it may be")
	}
}

func TestACoupledPortionIsNotFollowingItsOwnTwin(t *testing.T) {
	// Two portions joined together are one train carrying two numbers, drawn
	// at the same point because they are in the same place. 12177/5537,
	// Strasbourg to Nice, had one pushed a block back off the other.
	const gapKm = 0.4
	a := at("12177", 48.0, 2.0, 0, 160, 0.4)
	a.CoupledWith = []string{"5537"}
	b := at("5537", 48.0+gapKm/111, 2.0, 0, 160, 0.6)
	b.CoupledWith = []string{"12177"}

	got := Analyse([]Follower{a, b}, fixedSpacing(1500), nil, nil)
	for _, n := range []string{"12177", "5537"} {
		if got[n].PushedM != nil {
			t.Errorf("%s was pushed back off its own twin", n)
		}
		if got[n].Aspect != Libre {
			t.Errorf("%s got %q, want libre", n, got[n].Aspect)
		}
	}
}

func TestTrainsAtTheSamePointAreOneTrain(t *testing.T) {
	// Portions that run joined and split later share an origin rather than a
	// terminus, so the coupling detector misses them: 5500 to Metz and 12184 to
	// Strasbourg leave Montpellier at the same second, joined.
	trains := []Follower{
		at("5500", 48.0, 2.0, 0, 160, 0.4),
		at("12184", 48.0+0.05/111, 2.0, 0, 160, 0.6), // 50 m apart
	}
	got := Analyse(trains, fixedSpacing(1500), nil, nil)
	if got["5500"].PushedM != nil {
		t.Error("a train was pushed back off one at the same point")
	}
}

func TestATrainIsNotHeldByOneBehindIt(t *testing.T) {
	// Progress decides which is in front; a train behind constrains nothing.
	trains := []Follower{
		at("front", 48.0, 2.0, 0, 160, 0.8),
		at("back", 48.0+0.5/111, 2.0, 0, 160, 0.2), // nearer the pole, but behind
	}
	got := Analyse(trains, fixedSpacing(1500), nil, nil)
	if got["front"].Ahead != "" {
		t.Errorf("the leading train was held by %q", got["front"].Ahead)
	}
}

func TestTrainsGoingOppositeWaysDoNotFollowEachOther(t *testing.T) {
	trains := []Follower{
		at("north", 48.0, 2.0, 0, 160, 0.4),
		at("south", 48.0+0.5/111, 2.0, 180, 160, 0.6),
	}
	got := Analyse(trains, fixedSpacing(1500), nil, nil)
	if got["north"].Aspect != Libre {
		t.Errorf("aspect = %q, want libre — the other train is coming the other way", got["north"].Aspect)
	}
}

func TestOnSingleTrackAnOncomingTrainIsTheConstraint(t *testing.T) {
	// They cannot pass at all, so one is standing in a loop. Both are reported
	// and neither is moved: which one is waiting is not knowable from the
	// timetable.
	single := func(_, _ float64) Layout { return Layout{Single: true, Tracks: 1} }
	trains := []Follower{
		at("north", 48.0, 2.0, 0, 100, 0.4),
		at("south", 48.0+1.0/111, 2.0, 180, 100, 0.6),
	}
	got := Analyse(trains, fixedSpacing(1500), nil, single)

	for _, n := range []string{"north", "south"} {
		if !got[n].Opposing {
			t.Errorf("%s was not marked as facing an oncoming train", n)
		}
		if got[n].Aspect != Semaphore {
			t.Errorf("%s got %q, want semaphore", n, got[n].Aspect)
		}
		if got[n].PushedM != nil {
			t.Errorf("%s was moved, but which train is waiting is not knowable", n)
		}
	}
}

func TestRealSignalGeometryBeatsTheBlockEstimate(t *testing.T) {
	// Where the signalling layer knows where the signal is, that is where the
	// train would actually be brought to a stand.
	const gapKm = 2.0
	trains := []Follower{
		at("behind", 48.0, 2.0, 0, 200, 0.4),
		at("ahead", 48.0+gapKm/111, 2.0, 0, 120, 0.6),
	}
	sig := func(_, _, _ float64) (Signal, bool) {
		return Signal{M: 400, Kind: "carre"}, true
	}
	got := Analyse(trains, fixedSpacing(1500), sig, nil)

	if got["behind"].SignalM == nil || *got["behind"].SignalM != 400 {
		t.Errorf("signal distance = %v, want 400", got["behind"].SignalM)
	}
	if got["behind"].SignalKind != "carre" {
		t.Errorf("signal kind = %q, want carre", got["behind"].SignalKind)
	}
	// 400 m from a stand allows far less than the 1 250 m the block estimate
	// would have given.
	if got["behind"].AllowedKmh == nil || *got["behind"].AllowedKmh > 80 {
		t.Errorf("allowed speed = %v, want the tighter figure the real signal gives",
			got["behind"].AllowedKmh)
	}
}

func TestOnlyRunningTrainsAreConstrained(t *testing.T) {
	// One standing in a station is where the timetable says it is, and one that
	// has arrived is done.
	standing := at("standing", 48.0, 2.0, 0, 0, 0.4)
	standing.Position.Basis = train.AtStation
	trains := []Follower{standing, at("ahead", 48.0+0.5/111, 2.0, 0, 120, 0.6)}

	got := Analyse(trains, fixedSpacing(1500), nil, nil)
	if _, held := got["standing"]; held {
		t.Error("a train standing in a station was given traffic")
	}
}

func TestTrainsOnDifferentLinesDoNotInteract(t *testing.T) {
	a := at("1", 48.0, 2.0, 0, 160, 0.4)
	b := at("2", 48.0+0.5/111, 2.0, 0, 160, 0.6)
	b.Line = "another"
	got := Analyse([]Follower{a, b}, fixedSpacing(1500), nil, nil)
	if got["1"].Ahead != "" {
		t.Errorf("held by %q, which is on a different line", got["1"].Ahead)
	}
}
