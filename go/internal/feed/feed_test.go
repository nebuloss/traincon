package feed

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	rt "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"

	"traincon/internal/gtfs"
)

func TestSortCallsByTime(t *testing.T) {
	// The feed lists calls in order almost always, which is why insertion sort
	// is the right shape — but "almost" is why it is sorted at all.
	calls := []Call{{Time: 30}, {Time: 10}, {Time: 20}}
	sortCallsByTime(calls)
	for i, want := range []int64{10, 20, 30} {
		if calls[i].Time != want {
			t.Errorf("calls[%d] = %d, want %d", i, calls[i].Time, want)
		}
	}
}

func TestSortCallsByTimeIsStableOnAnAlreadySortedJourney(t *testing.T) {
	calls := []Call{{Time: 1, Name: "a"}, {Time: 2, Name: "b"}, {Time: 3, Name: "c"}}
	sortCallsByTime(calls)
	if calls[0].Name != "a" || calls[2].Name != "c" {
		t.Errorf("order disturbed: %v", calls)
	}
}

func TestEventReadsDistinguishAbsentFromZero(t *testing.T) {
	// "On time" and "not reported" are different answers, and which one a call
	// gives decides whether the other side of it is consulted instead.
	onTime := &rt.TripUpdate_StopTimeEvent{Delay: proto.Int32(0), Time: proto.Int64(100)}
	if d, ok := eventDelay(onTime); !ok || d != 0 {
		t.Errorf("a reported zero delay came back as (%d,%v), want (0,true)", d, ok)
	}
	silent := &rt.TripUpdate_StopTimeEvent{Time: proto.Int64(100)}
	if _, ok := eventDelay(silent); ok {
		t.Error("an unreported delay came back as reported")
	}
	if _, ok := eventTime(&rt.TripUpdate_StopTimeEvent{}); ok {
		t.Error("an event with no time came back as having one")
	}
	if _, ok := eventTime(nil); ok {
		t.Error("a missing event came back as having a time")
	}
}

// entity builds one trip update. The id shape is the real one: the feed
// numbers trains "OCESN29950F" — three fixed letters, an operator code, the
// number, and a terminator.
func entity(id string, stops ...*rt.TripUpdate_StopTimeUpdate) *rt.FeedEntity {
	return &rt.FeedEntity{
		Id:         proto.String(id),
		TripUpdate: &rt.TripUpdate{StopTimeUpdate: stops},
	}
}

func stopAt(stopID string, at int64) *rt.TripUpdate_StopTimeUpdate {
	return &rt.TripUpdate_StopTimeUpdate{
		StopId:    proto.String(stopID),
		Departure: &rt.TripUpdate_StopTimeEvent{Time: proto.Int64(at), Delay: proto.Int32(60)},
	}
}

func testStatics() *gtfs.Static {
	return &gtfs.Static{
		Stops: map[string]gtfs.Stop{
			"A": {ID: "A", Name: "Ailleurs", Lat: 48, Lon: 2},
			"B": {ID: "B", Name: "Bourg", Lat: 47, Lon: 3},
		},
		Trains: map[string]gtfs.TrainMeta{
			"SN12345": {Number: "12345", Service: "OUI", Line: "Paris - Lyon"},
		},
	}
}

func TestBuildTrainRejections(t *testing.T) {
	st := testStatics()
	tests := []struct {
		name string
		e    *rt.FeedEntity
	}{
		{"an id that is not a train number", entity("something-else", stopAt("A", 100), stopAt("B", 200))},
		{"no stop time updates", entity("OCESN12345F")},
		{"only one usable call", entity("OCESN12345F", stopAt("A", 100))},
		{"stops the schedule does not know", entity("OCESN12345F", stopAt("X", 100), stopAt("Y", 200))},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := buildTrain(tc.e, st, 0, 0); ok {
				t.Error("accepted an entity that carries no usable journey")
			}
		})
	}
}

func TestBuildTrainReadsTheJourney(t *testing.T) {
	st := testStatics()
	got, ok := buildTrain(entity("OCESN12345F", stopAt("A", 100), stopAt("B", 200)), st, 999, 0)
	if !ok {
		t.Fatal("rejected a usable journey")
	}
	if got.Number != "12345" {
		t.Errorf("number = %q, want 12345", got.Number)
	}
	if got.Service != "OUI" || got.Line != "Paris - Lyon" {
		t.Errorf("service/line = %q/%q, want OUI/Paris - Lyon", got.Service, got.Line)
	}
	if got.Origin != "Ailleurs" || got.Destination != "Bourg" {
		t.Errorf("origin/destination = %q/%q, want Ailleurs/Bourg", got.Origin, got.Destination)
	}
	if got.MaxDelay != 60 || got.LastDelay != 60 {
		t.Errorf("delays = %d/%d, want 60/60", got.MaxDelay, got.LastDelay)
	}
	if got.FeedTS != 999 {
		t.Errorf("feedTS = %d, want 999", got.FeedTS)
	}
}

func TestBuildTrainShiftsAReplayedCapture(t *testing.T) {
	// A capture replayed onto the present has every instant moved by the same
	// amount, or the journey would be internally inconsistent.
	st := testStatics()
	const shift = 1000
	got, ok := buildTrain(entity("OCESN12345F", stopAt("A", 100), stopAt("B", 200)), st, 0, shift)
	if !ok {
		t.Fatal("rejected a usable journey")
	}
	if got.Calls[0].Time != 100+shift || got.Calls[1].Time != 200+shift {
		t.Errorf("times = %d,%d, want %d,%d",
			got.Calls[0].Time, got.Calls[1].Time, 100+shift, 200+shift)
	}
	if got.Calls[0].Departure != 100+shift {
		t.Errorf("departure = %d, want %d", got.Calls[0].Departure, 100+shift)
	}
}

func TestBuildTrainMarksCancellation(t *testing.T) {
	st := testStatics()
	e := entity("OCESN12345F", stopAt("A", 100), stopAt("B", 200))
	e.TripUpdate.Trip = &rt.TripDescriptor{
		ScheduleRelationship: rt.TripDescriptor_CANCELED.Enum(),
	}
	got, ok := buildTrain(e, st, 0, 0)
	if !ok {
		t.Fatal("rejected a usable journey")
	}
	if !got.Cancelled {
		t.Error("a cancelled trip did not come back cancelled")
	}
}

// TestDecodeTheBundledCapture reads the capture committed beside this test.
//
// It needs no schedule, so it runs anywhere — which matters because everything
// else that exercises the protobuf path needs the 4 MB GTFS archive and is
// skipped in CI for want of it. The counts are what the feed actually carried
// when it was captured.
func TestDecodeTheBundledCapture(t *testing.T) {
	msg, err := decodeFile(filepath.Join("testdata", "trip-updates.pb"))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	entities, stops := 0, 0
	for _, e := range msg.GetEntity() {
		entities++
		stops += len(e.GetTripUpdate().GetStopTimeUpdate())
	}
	if entities == 0 || stops == 0 {
		t.Fatalf("decoded %d entities and %d stop time updates", entities, stops)
	}
	// A feed of trip updates and nothing else: no vehicle positions, no
	// alerts. If that ever changes, the assumption behind the decode has.
	for _, e := range msg.GetEntity() {
		if e.GetVehicle() != nil || e.GetAlert() != nil {
			t.Fatalf("entity %s carries something other than a trip update", e.GetId())
		}
	}
	if ts := msg.GetHeader().GetTimestamp(); ts == 0 {
		t.Error("the header carries no timestamp")
	}
}

// TestLoadMatchesTheTypeScriptTrainCount replays the same capture the
// TypeScript harness used and checks it yields the same trains.
//
// That server reported 1 075 from this pairing of capture and schedule. Getting
// the same number means the id pattern, the stop lookup, the two-call minimum
// and the schedule join all agree — the whole decode, end to end. It needs the
// GTFS archive, so it skips where that is absent.
func TestLoadMatchesTheTypeScriptTrainCount(t *testing.T) {
	dir := os.Getenv("TRAINCON_DATA")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "data")
	}
	capture := filepath.Join(dir, "leak-hunt-feed.pb")
	if _, err := os.Stat(capture); err != nil {
		t.Skipf("no capture at %s", capture)
	}

	statics, err := gtfs.Load(context.Background(), dir)
	if err != nil {
		t.Skipf("no schedule: %v", err)
	}

	c := &Client{File: capture, Shift: ShiftNone}
	got, err := c.Load(context.Background(), statics)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := 1075; len(got.Trains) != want {
		t.Errorf("trains = %d, want %d", len(got.Trains), want)
	}
	if !got.Replay {
		t.Error("a capture was not reported as replay")
	}
	if got.Shift != 0 {
		t.Errorf("shift = %d, want 0 under ShiftNone", got.Shift)
	}

	for _, tr := range got.Trains {
		if len(tr.Calls) < 2 {
			t.Fatalf("train %s kept with %d calls", tr.Number, len(tr.Calls))
		}
		for i := 1; i < len(tr.Calls); i++ {
			if tr.Calls[i].Time < tr.Calls[i-1].Time {
				t.Fatalf("train %s has calls out of order", tr.Number)
			}
		}
	}
}
