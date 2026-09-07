package disruptions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// one builds a Navitia disruption naming the given trains.
func one(effect, message string, numbers ...string) navitia {
	var d navitia
	d.Severity.Effect = effect
	if message != "" {
		d.Messages = append(d.Messages, struct {
			Text string `json:"text"`
		}{Text: message})
	}
	for _, n := range numbers {
		var obj struct {
			PTObject struct {
				Trip struct {
					Name string `json:"name"`
				} `json:"trip"`
			} `json:"pt_object"`
			ImpactedStops []struct {
				Cause string `json:"cause"`
			} `json:"impacted_stops"`
		}
		obj.PTObject.Trip.Name = n
		d.ImpactedObjects = append(d.ImpactedObjects, obj)
	}
	return d
}

func TestAbsorbIndexesEveryTrainNamed(t *testing.T) {
	into := map[string]Disruption{}
	absorb(one("SIGNIFICANT_DELAYS", "Obstacle sur la voie", "8540", "8582"), into)

	for _, n := range []string{"8540", "8582"} {
		got, ok := into[n]
		if !ok {
			t.Fatalf("%s was not indexed", n)
		}
		if got.Reason != "Obstacle sur la voie" {
			t.Errorf("%s reason = %q", n, got.Reason)
		}
		if got.Effect != "SIGNIFICANT_DELAYS" {
			t.Errorf("%s effect = %q", n, got.Effect)
		}
	}
}

func TestTheFirstWriterWins(t *testing.T) {
	// Pages come back newest-first, and a train that has had two incidents
	// should show the current one.
	into := map[string]Disruption{}
	absorb(one("NO_SERVICE", "Défaillance de matériel", "8540"), into)
	absorb(one("SIGNIFICANT_DELAYS", "Obstacle sur la voie", "8540"), into)

	if got := into["8540"].Reason; got != "Défaillance de matériel" {
		t.Errorf("reason = %q, want the first one seen", got)
	}
}

func TestAPerStopCauseStandsInForAMissingHeadline(t *testing.T) {
	// The same text in practice, but present on some disruptions that carry no
	// top-level message.
	d := one("SIGNIFICANT_DELAYS", "", "8540")
	d.ImpactedObjects[0].ImpactedStops = []struct {
		Cause string `json:"cause"`
	}{{Cause: "Réutilisation d'un train"}}

	into := map[string]Disruption{}
	absorb(d, into)
	if got := into["8540"].Reason; got != "Réutilisation d'un train" {
		t.Errorf("reason = %q, want the per-stop cause", got)
	}
}

func TestADisruptionWithNoReasonIsNotIndexed(t *testing.T) {
	// A row with no text says nothing, and showing an empty reason is worse
	// than showing none.
	into := map[string]Disruption{}
	absorb(one("SIGNIFICANT_DELAYS", "", "8540"), into)
	if len(into) != 0 {
		t.Errorf("indexed %d trains with no reason", len(into))
	}
}

func TestAnUnnamedTrainIsSkipped(t *testing.T) {
	into := map[string]Disruption{}
	absorb(one("SIGNIFICANT_DELAYS", "Obstacle", "", "  "), into)
	if len(into) != 0 {
		t.Errorf("indexed %d unnamed trains", len(into))
	}
}

func TestTrainNumbersAreTrimmed(t *testing.T) {
	into := map[string]Disruption{}
	absorb(one("SIGNIFICANT_DELAYS", "Obstacle", "  8540 "), into)
	if _, ok := into["8540"]; !ok {
		t.Errorf("indexed %v, want the trimmed number", into)
	}
}

func TestWithoutAKeyTheIndexIsInertButAnswers(t *testing.T) {
	// Ranking works either way; only the reason column goes quiet.
	i := &Index{byNumber: map[string]Disruption{}, stop: make(chan struct{})}
	if i.Enabled() {
		t.Error("reported enabled with no key")
	}
	if err := i.Refresh(context.Background()); err != nil {
		t.Errorf("Refresh with no key: %v", err)
	}
	if got := i.Reason("8540"); got != "" {
		t.Errorf("reason = %q, want empty", got)
	}
	if i.Size() != 0 {
		t.Errorf("size = %d, want 0", i.Size())
	}
}

// serve stands in for Navitia, returning the given pages in order.
func serve(t *testing.T, pages [][]navitia) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := 0
		if v := r.URL.Query().Get("start_page"); v != "" {
			if _, err := fmt.Sscanf(v, "%d", &page); err != nil {
				page = 0
			}
		}
		var items []navitia
		if page < len(pages) {
			items = pages[page]
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"disruptions": items})
	}))
}

func TestRefreshPagesUntilTheFeedRunsOut(t *testing.T) {
	srv := serve(t, [][]navitia{
		{one("SIGNIFICANT_DELAYS", "Obstacle", "1")},
		{one("NO_SERVICE", "Grève", "2")},
	})
	defer srv.Close()

	i := New()
	i.key, i.base = "test-key", srv.URL
	if err := i.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if i.Size() != 2 {
		t.Errorf("indexed %d trains, want 2 across both pages", i.Size())
	}
	if got := i.Reason("2"); got != "Grève" {
		t.Errorf("second page not read: %q", got)
	}
}

func TestAFailedSweepKeepsTheLastGoodAnswers(t *testing.T) {
	// A stale reason is better than none, and the ranking must not depend on
	// this call succeeding.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer failing.Close()

	i := New()
	i.key = "test-key"
	i.byNumber = map[string]Disruption{"8540": {Reason: "Obstacle sur la voie"}}
	i.base = failing.URL

	if err := i.Refresh(context.Background()); err == nil {
		t.Error("a 429 was not reported as an error")
	}
	if got := i.Reason("8540"); got != "Obstacle sur la voie" {
		t.Errorf("reason = %q, want the previous answer kept", got)
	}
}

func TestRefreshReportsAuthorisationFailures(t *testing.T) {
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer refusing.Close()

	i := New()
	i.key, i.base = "wrong", refusing.URL
	err := i.Refresh(context.Background())
	if err == nil {
		t.Fatal("a 401 was not reported")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error = %q, want it to name the status", err)
	}
}
