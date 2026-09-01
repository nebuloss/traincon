package api

import (
	"net/http/httptest"
	"testing"
)

func TestTrainFromPath(t *testing.T) {
	// The shapes people actually paste into a chat.
	tests := []struct {
		path      string
		wantTrain string
		wantTab   string
		ok        bool
	}{
		{"/train/8540", "8540", "", true},
		{"/train/8540/carte", "8540", "carte", true},
		{"/t/8540", "8540", "", true},
		{"/t/8540/trajet", "8540", "trajet", true},
		// Numbers are normalised, so a pasted lower-case letter still opens.
		{"/train/tgv1", "TGV1", "", true},
		// Not links to a train.
		{"/", "", "", false},
		{"/train", "", "", false},
		{"/train/", "", "", false},
		{"/other/8540", "", "", false},
		{"/train/much-too-long-to-be-a-number", "", "", false},
		{"/train/../../etc/passwd", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			got, ok := TrainFromPath(tc.path)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && (got.Train != tc.wantTrain || got.Tab != tc.wantTab) {
				t.Errorf("got %+v, want %s/%s", got, tc.wantTrain, tc.wantTab)
			}
		})
	}
}

func TestTrainFromQuery(t *testing.T) {
	tests := []struct {
		query     string
		wantTrain string
		wantTab   string
		ok        bool
	}{
		{"train=8540", "8540", "", true},
		{"train=8540&tab=carte", "8540", "carte", true},
		{"t=8540", "8540", "", true},
		{"train=tgv1", "TGV1", "", true},
		{"", "", "", false},
		{"other=8540", "", "", false},
		{"train=this-is-not-a-number", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.query, func(t *testing.T) {
			got, ok := TrainFromQuery(tc.query)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && (got.Train != tc.wantTrain || got.Tab != tc.wantTab) {
				t.Errorf("got %+v, want %s/%s", got, tc.wantTrain, tc.wantTab)
			}
		})
	}
}

func TestDelayText(t *testing.T) {
	tests := []struct {
		sec  int64
		want string
	}{
		{60, "+1 min"},
		{600, "+10 min"},
		{3600, "+1 h"},
		{3660, "+1 h 01"},
		{4500, "+1 h 15"},
		{12600, "+3 h 30"},
	}
	for _, tc := range tests {
		if got := delayText(tc.sec); got != tc.want {
			t.Errorf("delayText(%d) = %q, want %q", tc.sec, got, tc.want)
		}
	}
}

func TestOriginTrustsTheProxyHeaders(t *testing.T) {
	// The service runs behind a reverse proxy, and the link-preview crawlers
	// reject a relative og:image — so the tags must name the host the request
	// actually arrived on, not the loopback the process is bound to.
	r := httptest.NewRequest("GET", "http://localhost:3000/train/8540", nil)
	r.Header.Set("X-Forwarded-Host", "tchoutchoutrain.patapouf.club")
	r.Header.Set("X-Forwarded-Proto", "https")
	if got, want := origin(r), "https://tchoutchoutrain.patapouf.club"; got != want {
		t.Errorf("origin = %q, want %q", got, want)
	}
}

func TestOriginFallsBackToTheRequestHost(t *testing.T) {
	r := httptest.NewRequest("GET", "http://example.test/", nil)
	if got, want := origin(r), "http://example.test"; got != want {
		t.Errorf("origin = %q, want %q", got, want)
	}
}

func TestEveryAssetTheBundleShipsHasAType(t *testing.T) {
	// A manifest or an icon sent as octet-stream is ignored by the browser and
	// skipped by link-preview crawlers.
	for _, ext := range []string{".html", ".js", ".css", ".svg", ".png", ".json", ".webmanifest", ".ico", ".woff2"} {
		if mimeTypes[ext] == "" {
			t.Errorf("%s has no content type", ext)
		}
	}
}
