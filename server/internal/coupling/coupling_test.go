package coupling

import (
	"testing"

	"traincon/internal/feed"
	"traincon/internal/train"
)

// portion builds one half of a coupled service: its own origin, then a shared
// tail into the same terminus at the same booked minute.
//
// The scenario throughout is the one that prompted the code — 8540 and 8582,
// joined at Bordeaux and running to Paris as one train, with 8540's record left
// stale at +70 while 8582 had been corrected to +50.
func portion(number, origin string, delay int64) *train.Train {
	return &train.Train{
		Number:  number,
		Service: "OUI",
		Calls: []feed.Call{
			{StopID: origin, Name: origin, Lat: 43, Lon: 0, Time: 0, Departure: 0, HasDeparture: true},
			// The join, and then the shared run to the terminus.
			{
				StopID: "bordeaux", Name: "Bordeaux", Lat: 44.8, Lon: -0.55,
				Time: 3600 + delay, Arrival: 3600 + delay, HasArrival: true,
				Departure: 3660 + delay, HasDeparture: true, Delay: delay,
			},
			{
				StopID: "paris", Name: "Paris", Lat: 48.84, Lon: 2.37,
				Time: 10800 + delay, Arrival: 10800 + delay, HasArrival: true, Delay: delay,
			},
		},
	}
}

// now sits on the shared leg, between Bordeaux and Paris.
const now = 5000

func TestTwoPortionsIntoTheSameTerminusAreOneTrain(t *testing.T) {
	d := New()
	a := portion("8540", "hendaye", 70*60)
	b := portion("8582", "tarbes", 50*60)
	got := d.Detect([]*train.Train{a, b}, now, nil, nil)

	if len(got.Partners) != 2 {
		t.Fatalf("found %d members, want 2 — the set was not detected", len(got.Partners))
	}
	if len(got.Partners["8540"]) != 1 || got.Partners["8540"][0] != "8582" {
		t.Errorf("8540's partners = %v, want [8582]", got.Partners["8540"])
	}
}

func TestOnePhysicalTrainGetsOnePosition(t *testing.T) {
	// A set that has reached a point has reached it under every number.
	d := New()
	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 70*60),
		portion("8582", "tarbes", 50*60),
	}, now, nil, nil)

	a, okA := got.Positions["8540"]
	b, okB := got.Positions["8582"]
	if !okA || !okB {
		t.Fatal("both numbers should carry a position")
	}
	if a.Lat != b.Lat || a.Lon != b.Lon {
		t.Errorf("the two portions are at %v,%v and %v,%v", a.Lat, a.Lon, b.Lat, b.Lon)
	}
}

func TestTheFreshestRecordSettlesTheDelay(t *testing.T) {
	// 8540 sat at +70 all the way to Paris; 8582 had been corrected to +50 and
	// was revised more recently, so its figure is the one that stands.
	d := New()
	d.NoteChange("8540", 100)
	d.NoteChange("8582", 200) // revised later

	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 70*60),
		portion("8582", "tarbes", 50*60),
	}, now, nil, nil)

	for _, n := range []string{"8540", "8582"} {
		rec, ok := got.Delays[n]
		if !ok {
			t.Fatalf("%s has no reconciled delay", n)
		}
		if rec.Delay != 50*60 {
			t.Errorf("%s settled on %d s, want 3000 — the fresher figure", n, rec.Delay)
		}
		if rec.Source != "8582" {
			t.Errorf("%s cites %q as the source, want 8582", n, rec.Source)
		}
		if rec.Spread != 20*60 {
			t.Errorf("%s reports a spread of %d s, want 1200", n, rec.Spread)
		}
	}
}

func TestASubstantialDisagreementIsReported(t *testing.T) {
	d := New()
	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 70*60),
		portion("8582", "tarbes", 50*60),
	}, now, nil, nil)

	rec := got.Delays["8540"]
	if len(rec.Disagreement) != 2 {
		t.Fatalf("disagreement lists %d numbers, want 2", len(rec.Disagreement))
	}
}

func TestASmallDisagreementIsNotWorthFlagging(t *testing.T) {
	// Under five minutes the numbers agree well enough.
	d := New()
	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 120),
		portion("8582", "tarbes", 180),
	}, now, nil, nil)

	if rec := got.Delays["8540"]; rec.Disagreement != nil {
		t.Errorf("flagged a %d s spread, which is within tolerance", rec.Spread)
	}
}

func TestTheSharedTailTakesTheFreshestTimes(t *testing.T) {
	// Fixing only the headline figure leaves the timeline lying: the stale
	// portion's stop list still read Bordeaux 16:50 / Paris 19:06 while its
	// twin had 16:30 / 18:46.
	d := New()
	d.NoteChange("8582", 200)
	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 70*60),
		portion("8582", "tarbes", 50*60),
	}, now, nil, nil)

	corrected, ok := got.Calls["8540"]
	if !ok {
		t.Fatal("the stale portion's calls were not corrected")
	}
	// Paris is on the shared tail, so it takes the fresher time.
	var paris feed.Call
	for _, c := range corrected {
		if c.StopID == "paris" {
			paris = c
		}
	}
	if paris.Delay != 50*60 {
		t.Errorf("Paris still reads +%d s, want the fresher +3000", paris.Delay)
	}

	// The freshest member is not rewritten from itself.
	if _, rewritten := got.Calls["8582"]; rewritten {
		t.Error("the freshest portion's own calls were overwritten")
	}
}

func TestEachPortionKeepsItsOwnEarlierStops(t *testing.T) {
	// Hendaye against Tarbes: before the join each portion's stops are
	// genuinely its own, and must not be taken from the other.
	d := New()
	d.NoteChange("8582", 200)
	got := d.Detect([]*train.Train{
		portion("8540", "hendaye", 70*60),
		portion("8582", "tarbes", 50*60),
	}, now, nil, nil)

	for _, c := range got.Calls["8540"] {
		if c.StopID == "tarbes" {
			t.Error("8540 was given its twin's origin")
		}
	}
	if got.Calls["8540"][0].StopID != "hendaye" {
		t.Errorf("8540 starts at %q, want hendaye", got.Calls["8540"][0].StopID)
	}
}

func TestServicesIntoDifferentTerminiAreNotCoupled(t *testing.T) {
	d := New()
	a := portion("1", "x", 0)
	b := portion("2", "y", 0)
	b.Calls[2].StopID = "lyon" // a different terminus
	if got := d.Detect([]*train.Train{a, b}, now, nil, nil); len(got.Partners) != 0 {
		t.Errorf("coupled %d trains booked into different termini", len(got.Partners))
	}
}

func TestServicesBookedHoursApartAreNotCoupled(t *testing.T) {
	// The same terminus later in the day is a different train.
	d := New()
	a := portion("1", "x", 0)
	b := portion("2", "y", 0)
	for i := range b.Calls {
		b.Calls[i].Time += 3 * 3600
		b.Calls[i].Arrival += 3 * 3600
		b.Calls[i].Departure += 3 * 3600
	}
	if got := d.Detect([]*train.Train{a, b}, now, nil, nil); len(got.Partners) != 0 {
		t.Errorf("coupled %d trains booked hours apart", len(got.Partners))
	}
}

func TestALoneTrainIsNotCoupledToItself(t *testing.T) {
	d := New()
	if got := d.Detect([]*train.Train{portion("1", "x", 0)}, now, nil, nil); len(got.Partners) != 0 {
		t.Errorf("found partners for a single train: %v", got.Partners)
	}
}

func TestForgetKeepsTheMapBounded(t *testing.T) {
	d := New()
	d.NoteChange("1", 100)
	d.NoteChange("2", 100)
	if d.Size() != 2 {
		t.Fatalf("size = %d, want 2", d.Size())
	}
	d.Forget("1")
	if d.Size() != 1 {
		t.Errorf("size after forgetting = %d, want 1", d.Size())
	}
}
