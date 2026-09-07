package signals

import (
	"os"
	"path/filepath"
	"testing"
)

// A short stretch of double track running north, with a carré ahead.
func stretch() []Signal {
	return []Signal{
		{Lat: 48.00, Lon: 2.0, Type: "CARRE", Line: "420000", Voie: "V1"},
		{Lat: 48.02, Lon: 2.0, Type: "S", Line: "420000", Voie: "V1"},
		{Lat: 48.04, Lon: 2.0, Type: "CARRE", Line: "420000", Voie: "V2"},
		// Not a stop signal: it contributes only its track name.
		{Lat: 48.01, Lon: 2.0, Type: "SIFFLET", Line: "420000", Voie: "V2"},
	}
}

func TestOnlyStopSignalsAreIndexed(t *testing.T) {
	// Whistle boards and speed boards do not constrain spacing; they are read
	// for the name of the track they stand on and nothing else.
	idx := New(stretch())
	if got, want := idx.Size(), 3; got != want {
		t.Errorf("indexed %d stop signals, want %d", got, want)
	}
}

func TestSignalKinds(t *testing.T) {
	tests := []struct {
		typ   string
		stops bool
		kind  string
	}{
		{"CARRE", true, KindCarre},
		{"S", true, KindSemaphore},
		{"SIFFLET", false, KindSemaphore},
	}
	for _, tc := range tests {
		s := Signal{Type: tc.typ}
		if s.Stops() != tc.stops {
			t.Errorf("%s: Stops() = %v, want %v", tc.typ, s.Stops(), tc.stops)
		}
		if s.Stops() && s.Kind() != tc.kind {
			t.Errorf("%s: Kind() = %q, want %q", tc.typ, s.Kind(), tc.kind)
		}
	}
}

func TestNextAheadFindsTheNearestSignalInFront(t *testing.T) {
	idx := New(stretch())
	// Just south of the first carré, running north.
	got, ok := idx.NextAhead(47.99, 2.0, 0, 8, "")
	if !ok {
		t.Fatal("found nothing ahead")
	}
	if got.Signal.Lat != 48.00 {
		t.Errorf("found the signal at %v, want the nearest at 48.00", got.Signal.Lat)
	}
	if got.DistanceM < 900 || got.DistanceM > 1200 {
		t.Errorf("distance = %v m, want about 1 100", got.DistanceM)
	}
}

func TestNextAheadIgnoresWhatIsBehind(t *testing.T) {
	// The one just passed is behind by definition, and taking it would put a
	// braking curve on a signal the train has already cleared.
	idx := New(stretch())
	if _, ok := idx.NextAhead(48.05, 2.0, 0, 8, ""); ok {
		t.Error("found a signal ahead of a train running north past all of them")
	}
	// Running south, the same train has all three in front of it.
	if _, ok := idx.NextAhead(48.05, 2.0, 180, 8, ""); !ok {
		t.Error("found nothing ahead of a train running south")
	}
}

func TestNextAheadKeepsToTheTrainsOwnLine(t *testing.T) {
	idx := New([]Signal{
		{Lat: 48.00, Lon: 2.0, Type: "CARRE", Line: "420000"},
		{Lat: 48.01, Lon: 2.0, Type: "CARRE", Line: "830000"},
	})
	got, ok := idx.NextAhead(47.99, 2.0, 0, 8, "830000")
	if !ok {
		t.Fatal("found nothing")
	}
	if got.Signal.Line != "830000" {
		t.Errorf("found a signal on line %q, want 830000", got.Signal.Line)
	}
}

func TestNextAheadRespectsTheRange(t *testing.T) {
	idx := New(stretch())
	if _, ok := idx.NextAhead(47.0, 2.0, 0, 8, ""); ok {
		t.Error("found a signal 100 km away within an 8 km range")
	}
}

func TestNextAheadTreatsOneUnderfootAsPassed(t *testing.T) {
	// Under 20 m there is no telling ahead from behind.
	idx := New([]Signal{{Lat: 48.0, Lon: 2.0, Type: "CARRE"}})
	if _, ok := idx.NextAhead(48.0, 2.0, 0, 8, ""); ok {
		t.Error("a signal underfoot was reported as ahead")
	}
}

func TestTracksNearReadsSingleTrackFromTheLayer(t *testing.T) {
	// UNIQUE is published explicitly, which beats inferring single track from
	// a count: a quiet double-track section might carry one signal in a cell.
	single := New([]Signal{
		{Lat: 45.0, Lon: 3.0, Type: "S", Voie: "UNIQUE"},
		{Lat: 45.001, Lon: 3.0, Type: "SIFFLET", Voie: "UNIQUE"},
	})
	if got := single.TracksNear(45.0, 3.0); !got.Single {
		t.Errorf("got %+v, want single track", got)
	}

	double := New(stretch())
	if got := double.TracksNear(48.0, 2.0); got.Single {
		t.Errorf("got %+v, want double track", got)
	}
}

func TestTracksNearCountsRunningTracksNotPlatformRoads(t *testing.T) {
	// A passing loop at a station on a single-track line is still a
	// single-track line either side of it.
	idx := New([]Signal{
		{Lat: 45.0, Lon: 3.0, Type: "S", Voie: "UNIQUE"},
		{Lat: 45.0, Lon: 3.0, Type: "S", Voie: "A"},
		{Lat: 45.0, Lon: 3.0, Type: "S", Voie: "B"},
	})
	got := idx.TracksNear(45.0, 3.0)
	if !got.Single {
		t.Errorf("got %+v, want single — A and B are platform roads", got)
	}
}

func TestTracksNearWithNothingAround(t *testing.T) {
	idx := New(stretch())
	if got := idx.TracksNear(10, 10); got.Tracks != 0 || got.Single {
		t.Errorf("got %+v, want an empty layout far from anything", got)
	}
}

func TestLineAtNamesTheInfrastructureLine(t *testing.T) {
	// Trains carry a commercial label and two on the same route often carry
	// different ones; the infrastructure code describes the track instead.
	idx := New(stretch())
	if got := idx.LineAt(48.0, 2.0, 2); got != "420000" {
		t.Errorf("got %q, want 420000", got)
	}
	if got := idx.LineAt(10, 10, 2); got != "" {
		t.Errorf("got %q far from anything, want empty", got)
	}
}

func TestANilIndexAnswersEmptily(t *testing.T) {
	// The layer is optional, so a nil index must behave rather than panic.
	var idx *Index
	if _, ok := idx.NextAhead(48, 2, 0, 8, ""); ok {
		t.Error("a nil index found a signal")
	}
	if got := idx.TracksNear(48, 2); got.Tracks != 0 {
		t.Errorf("got %+v, want empty", got)
	}
	if got := idx.LineAt(48, 2, 2); got != "" {
		t.Errorf("got %q, want empty", got)
	}
	if idx.Size() != 0 {
		t.Errorf("size = %d, want 0", idx.Size())
	}
}

func TestLoadTreatsAMissingFileAsAbsent(t *testing.T) {
	idx, err := Load(t.TempDir())
	if err != nil {
		t.Errorf("a missing file gave an error: %v", err)
	}
	if idx != nil {
		t.Error("a missing file produced an index")
	}
}

// TestLoadMatchesThePublishedCount reads the real layer and checks it carries
// what the packing tool recorded: 24 673 stop signals.
func TestLoadMatchesThePublishedCount(t *testing.T) {
	dir := os.Getenv("TRAINCON_DATA")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "data")
	}
	if _, err := os.Stat(filepath.Join(dir, "geo", "signals.json")); err != nil {
		t.Skipf("no signalling layer at %s", dir)
	}

	idx, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if idx == nil {
		t.Fatal("the layer loaded as absent")
	}
	if got, want := idx.Size(), 24673; got != want {
		t.Errorf("loaded %d stop signals, want %d", got, want)
	}
}
