package store

import (
	"encoding/json"
	"testing"

	"traincon/internal/coupling"
	"traincon/internal/feed"
	"traincon/internal/train"
)

// The client reads these payloads by name, and Go's default encoding uses the
// Go field name. Comparing the two servers field by field found four breaks
// that way — calls serialised as StopID rather than stopId, next reduced to
// three fields, avgKmh present where there is nothing to average, and an
// unknown service marker sent as "" instead of null.
//
// These pin the wire format so the next one is caught by `go test` rather than
// by running both servers side by side.

// keys returns the JSON object keys of a marshalled value.
func keys(t *testing.T, v any) map[string]json.RawMessage {
	t.Helper()
	body, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func requireKeys(t *testing.T, got map[string]json.RawMessage, want ...string) {
	t.Helper()
	for _, k := range want {
		if _, ok := got[k]; !ok {
			have := make([]string, 0, len(got))
			for k := range got {
				have = append(have, k)
			}
			t.Errorf("missing %q; the payload carries %v", k, have)
		}
	}
}

func TestACallGoesOnTheWireWithTheClientsNames(t *testing.T) {
	c := feed.Call{
		StopID: "X", Name: "Gare", Lat: 48, Lon: 2,
		Arrival: 100, HasArrival: true, Departure: 200, HasDeparture: true,
		Time: 200, Delay: 60, Skipped: false,
	}
	got := keys(t, c)
	requireKeys(t, got, "stopId", "name", "lat", "lon", "arrival", "departure", "time", "delay", "skipped")
	for _, wrong := range []string{"StopID", "Name", "Lat", "HasArrival", "HasDeparture"} {
		if _, leaked := got[wrong]; leaked {
			t.Errorf("%q leaked onto the wire", wrong)
		}
	}
}

func TestAnAbsentCallTimeIsNullNotZero(t *testing.T) {
	// A terminus has no departure, and the client distinguishes "none" from
	// "midnight on the first of January 1970".
	terminus := feed.Call{StopID: "X", Arrival: 100, HasArrival: true, Time: 100}
	got := keys(t, terminus)
	if string(got["departure"]) != "null" {
		t.Errorf("departure = %s, want null", got["departure"])
	}
	if string(got["arrival"]) == "null" {
		t.Error("arrival came back null, but this call has one")
	}
}

func TestACallRoundTripsThroughItsWireForm(t *testing.T) {
	// The snapshot the store writes is read back by the next boot.
	want := feed.Call{
		StopID: "X", Name: "Gare", Lat: 48.5, Lon: 2.5,
		Arrival: 100, HasArrival: true, Time: 100, Delay: -30, Skipped: true,
	}
	body, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got feed.Call
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got != want {
		t.Errorf("round trip gave %+v, want %+v", got, want)
	}
}

func TestTheFullDTOCarriesTheWholeNextCall(t *testing.T) {
	// The link-preview card reads next.stopId to tell the terminus from an
	// intermediate stop; a reduced form cannot answer that.
	dto := TrainDTO{Next: &feed.Call{StopID: "X", Name: "Gare", Time: 100}}
	got := keys(t, dto)
	var next map[string]json.RawMessage
	if err := json.Unmarshal(got["next"], &next); err != nil {
		t.Fatalf("next is not an object: %v", err)
	}
	requireKeys(t, next, "stopId", "name", "time", "delay", "lat", "lon")
}

func TestAnUnknownServiceMarkerIsNull(t *testing.T) {
	// The client's type is string | null, and "" is neither.
	got := keys(t, TrainDTO{})
	if string(got["service"]) != "null" {
		t.Errorf("service = %s, want null", got["service"])
	}
}

func TestAvgKmhBelongsToARoutedLegOnly(t *testing.T) {
	// A straight-line fallback has no track distance to average over, so the
	// field is absent rather than zero.
	direct := keys(t, train.Position{Geometry: "direct"})
	if _, present := direct["avgKmh"]; present {
		t.Error("avgKmh was reported for straight-line geometry")
	}

	avg := 120.0
	routed := keys(t, train.Position{Geometry: "rail", AvgKmh: &avg})
	if _, present := routed["avgKmh"]; !present {
		t.Error("avgKmh was omitted from a routed leg")
	}
}

func TestTheFullDTOKeepsEveryFieldTheClientReads(t *testing.T) {
	got := keys(t, TrainDTO{})
	requireKeys(t, got,
		"id", "number", "service", "serviceLabel", "family", "line",
		"origin", "destination", "calls", "cancelled",
		"delay", "ownDelay", "worstDelay", "position", "next", "trend",
		"history", "coupledWith", "reconciled", "traffic", "feedTs")
}

func TestTheMapPayloadKeepsEveryFieldTheMapReads(t *testing.T) {
	got := keys(t, LightDTO{})
	requireKeys(t, got,
		"number", "service", "family", "origin", "destination",
		"delay", "cancelled", "trend", "coupledWith",
		"lat", "lon", "bearing", "basis", "speedKmh",
		"geometry", "quality", "observation", "next")
}

func TestAPositionKeepsEveryFieldTheMapReads(t *testing.T) {
	got := keys(t, train.Position{})
	requireKeys(t, got,
		"basis", "lat", "lon", "bearing", "progress",
		"nextStop", "speedKmh", "geometry", "observation", "quality")
}

func TestEmptyListsGoOutAsListsNotNull(t *testing.T) {
	// The client iterates these without checking; a null would throw.
	s := &Store{couples: &coupling.Result{}, history: map[string][]DelaySample{}}
	v := view{train: &train.Train{Calls: []feed.Call{{Time: 1}, {Time: 2}}}, corrected: &train.Train{Calls: []feed.Call{{Time: 1}, {Time: 2}}}}
	got := keys(t, s.toDTO(v, 0))
	for _, field := range []string{"coupledWith", "history"} {
		if string(got[field]) == "null" {
			t.Errorf("%s = null, want an empty array", field)
		}
	}
}
