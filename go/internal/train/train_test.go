package train

import (
	"math"
	"testing"

	"traincon/internal/feed"
	"traincon/internal/gtfs"
)

// A three-stop journey with a dwell at the middle station, which is the shape
// every leg rule has to be judged against.
//
//	  0 s  depart A
//	600 s  arrive B
//	660 s  depart B      (a minute on the platform)
//	1260 s arrive C
func journey() *Train {
	return &Train{
		Number:  "12345",
		Service: "TER",
		Calls: []feed.Call{
			{Name: "A", Lat: 48.0, Lon: 2.0, Time: 0, Departure: 0, HasDeparture: true, Delay: 0},
			{
				Name: "B", Lat: 48.5, Lon: 2.5,
				Time: 600, Arrival: 600, HasArrival: true, Departure: 660, HasDeparture: true,
				Delay: 120,
			},
			{Name: "C", Lat: 49.0, Lon: 3.0, Time: 1260, Arrival: 1260, HasArrival: true, Delay: 60},
		},
	}
}

func TestLegAt(t *testing.T) {
	tr := journey()
	tests := []struct {
		name      string
		now       int64
		wantBasis Basis
		wantFrom  string
	}{
		{"before departure", -10, NotDeparted, "A"},
		{"running to B", 300, Between, "A"},
		{"standing at B", 620, AtStation, "B"},
		{"running to C", 900, Between, "B"},
		{"arrived", 1300, Arrived, "C"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			leg := tr.LegAt(tc.now)
			if leg.Basis != tc.wantBasis {
				t.Errorf("basis = %q, want %q", leg.Basis, tc.wantBasis)
			}
		})
	}
}

func TestLegAtPlacesADwellingTrainOnItsPlatform(t *testing.T) {
	// Checked before the between-stations case, or a train standing at B would
	// be drawn somewhere on the way to C.
	leg := journey().LegAt(620)
	if leg.Basis != AtStation || leg.A.Name != "B" {
		t.Errorf("got %q at %q, want at_station at B", leg.Basis, leg.A.Name)
	}
	if leg.F != 0 {
		t.Errorf("fraction = %v, want 0 while standing", leg.F)
	}
}

func TestLegAtFractionRunsFromZeroToOne(t *testing.T) {
	tr := journey()
	// Departs A at 0, due B at 600.
	for _, tc := range []struct {
		now  int64
		want float64
	}{{0, 0}, {150, 0.25}, {300, 0.5}, {599, 0.998}} {
		leg := tr.LegAt(tc.now)
		if math.Abs(leg.F-tc.want) > 0.01 {
			t.Errorf("at %ds: f = %.3f, want %.3f", tc.now, leg.F, tc.want)
		}
	}
}

func TestCurrentDelayIsTheOneStillAhead(t *testing.T) {
	// The bug this exists for: a train that lost time early and clawed some
	// back should report what is left, not the worst it ever was.
	tr := journey()
	if got, want := tr.WorstDelay(), int64(120); got != want {
		t.Errorf("worst delay = %d, want %d", got, want)
	}
	// Before B, the delay ahead is B's 120.
	if got := tr.CurrentDelay(300); got != 120 {
		t.Errorf("delay before B = %d, want 120", got)
	}
	// After B, it is C's 60 — the train has recovered a minute.
	if got := tr.CurrentDelay(900); got != 60 {
		t.Errorf("delay after B = %d, want 60", got)
	}
	// Past the end there is nothing ahead, so the terminus stands.
	if got := tr.CurrentDelay(9999); got != 60 {
		t.Errorf("delay after arrival = %d, want 60", got)
	}
}

func TestObservationGradesHowStaleTheEstimateIs(t *testing.T) {
	tr := journey()
	tests := []struct {
		name string
		now  int64
		want Confidence
	}{
		// Ages are measured from the last stop actually passed, which after
		// 1 260 s is the terminus.
		{"nothing passed yet", -10, Scheduled},
		{"just left A", 60, Confirmed},
		{"ten minutes past the last stop", 1260 + 10*60, Good},
		{"half an hour past it", 1260 + 30*60, Estimated},
		{"an hour past it", 1260 + 60*60, Stale},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tr.ObservationAt(tc.now).Confidence; got != tc.want {
				t.Errorf("confidence = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestObservationBeforeDepartureNamesNoStop(t *testing.T) {
	obs := journey().ObservationAt(-10)
	if obs.LastStop != "" || obs.AgeSec != nil {
		t.Errorf("got %+v, want no last stop", obs)
	}
}

func TestPositionWithoutAGraphFallsBackToAStraightLine(t *testing.T) {
	tr := journey()
	pos := tr.PositionAt(300, nil, nil)

	if pos.Geometry != "direct" {
		t.Errorf("geometry = %q, want direct", pos.Geometry)
	}
	if pos.Quality.Method != "great_circle" {
		t.Errorf("method = %q, want great_circle", pos.Quality.Method)
	}
	// Halfway from A to B.
	if math.Abs(pos.Lat-48.25) > 0.01 {
		t.Errorf("lat = %v, want about 48.25", pos.Lat)
	}
	if pos.NextStop == nil || *pos.NextStop != "B" {
		t.Errorf("next stop = %v, want B", pos.NextStop)
	}
	if pos.FromStop != "A" {
		t.Errorf("from stop = %q, want A", pos.FromStop)
	}
}

func TestPositionAtRestIsOnTheStation(t *testing.T) {
	tr := journey()

	before := tr.PositionAt(-10, nil, nil)
	if before.Lat != 48.0 || before.SpeedKmh != 0 {
		t.Errorf("before departure: %v,%v at %v km/h — want A at rest",
			before.Lat, before.Lon, before.SpeedKmh)
	}

	arrived := tr.PositionAt(1300, nil, nil)
	if arrived.Lat != 49.0 || arrived.SpeedKmh != 0 {
		t.Errorf("arrived: %v,%v at %v km/h — want C at rest",
			arrived.Lat, arrived.Lon, arrived.SpeedKmh)
	}
	if arrived.NextStop != nil {
		t.Errorf("next stop after arrival = %v, want none", *arrived.NextStop)
	}
	if arrived.AtStation != "C" {
		t.Errorf("at station = %q, want C", arrived.AtStation)
	}
}

func TestProgressSpansTheWholeJourney(t *testing.T) {
	tr := journey()
	start := tr.PositionAt(0, nil, nil).Progress
	mid := tr.PositionAt(620, nil, nil).Progress
	end := tr.PositionAt(1300, nil, nil).Progress
	if start != 0 {
		t.Errorf("progress at departure = %v, want 0", start)
	}
	if math.Abs(mid-0.5) > 1e-9 {
		t.Errorf("progress at B = %v, want 0.5", mid)
	}
	if math.Abs(end-1) > 1e-9 {
		t.Errorf("progress at arrival = %v, want 1", end)
	}
}

func TestPlausibleSpeed(t *testing.T) {
	tests := []struct {
		name     string
		kmh      float64
		family   gtfs.Family
		limit    float64
		hasLimit bool
		want     float64
	}{
		// The report this exists for, with the numbers it had.
		{"a TER cannot do 266", 266, gtfs.FamilyTER, 220, true, 200},
		{"the line limit holds even when the stock could go faster", 300, gtfs.FamilyTGV, 160, true, 160},
		{"the stock limit holds even where the line allows more", 220, gtfs.FamilyTER, 220, true, 200},
		{"a plausible speed passes through untouched", 140, gtfs.FamilyTER, 160, true, 140},
		{"the stock limit applies with no line speed at all", 400, gtfs.FamilyTER, 0, false, 200},
		// The cap must leave the real thing alone: the fleet is cleared for 320
		// on the LGV Est, and trains are reported doing it.
		{"a TGV can still do 320, because it does", 320, gtfs.FamilyTGV, 320, true, 320},
		{"and no further", 328, gtfs.FamilyTGV, 320, true, 320},
		// Strasbourg to Bâle really runs at 200, and it is one of the two
		// trains this was noticed on.
		{"a TER 200 can still do 200", 200, gtfs.FamilyTER, 220, true, 200},
		{"an unknown family still gets a ceiling", 400, gtfs.Family("draisine"), 0, false, 160},
		{"nothing comes back negative", -50, gtfs.FamilyTER, 160, true, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := PlausibleSpeed(tc.kmh, tc.family, tc.limit, tc.hasLimit)
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStockLimitsAreOrderedAsTheTrainsAre(t *testing.T) {
	if StockMaxKmh[gtfs.FamilyTGV] <= StockMaxKmh[gtfs.FamilyIC] {
		t.Error("a TGV should outrun a Corail set")
	}
	if StockMaxKmh[gtfs.FamilyTER] < 200 {
		t.Error("the TER ceiling is the family maximum, not the common one")
	}
	for _, f := range []gtfs.Family{gtfs.FamilyTGV, gtfs.FamilyIC, gtfs.FamilyTER, gtfs.FamilyOther} {
		if StockMaxKmh[f] <= 0 {
			t.Errorf("family %q has no ceiling", f)
		}
	}
}

func TestWithCallsLeavesTheOriginalAlone(t *testing.T) {
	// A coupled twin's fresher calls must not rewrite the train they came from.
	tr := journey()
	swapped := tr.WithCalls([]feed.Call{{Name: "X", Time: 1}, {Name: "Y", Time: 2}})
	if tr.Calls[0].Name != "A" {
		t.Error("the original's calls were replaced")
	}
	if swapped.Number != tr.Number {
		t.Error("the copy lost its identity")
	}
	if swapped.Destination() != "Y" {
		t.Errorf("the copy's destination = %q, want Y", swapped.Destination())
	}
}
