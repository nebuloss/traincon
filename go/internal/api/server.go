// Package api serves the JSON API and the client bundle.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"traincon/internal/gtfs"
	"traincon/internal/store"
)

// Server answers requests from the store.
type Server struct {
	store     *store.Store
	publicDir string
	http      *http.Server
	listener  net.Listener
}

// New returns a server reading from st and serving the bundle in publicDir.
func New(st *store.Store, publicDir string) *Server {
	s := &Server{store: st, publicDir: publicDir}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/stats", s.stats)
	mux.HandleFunc("/api/refresh", s.refresh)
	mux.HandleFunc("/api/trains", s.trains)
	mux.HandleFunc("/api/worst", s.worst)
	mux.HandleFunc("/api/suggest", s.suggest)
	mux.HandleFunc("/api/rail.geojson", s.railGeoJSON)
	// Everything else: the per-train routes, then the bundle.
	mux.HandleFunc("/", s.rest)

	s.http = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
}

// Listen binds the port and starts serving. Port 0 picks a free one, which the
// tests use; Port reports what was chosen.
func (s *Server) Listen(port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return err
	}
	s.listener = ln
	go func() {
		if err := s.http.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			panic(err)
		}
	}()
	return nil
}

// Port is the bound port, meaningful after Listen.
func (s *Server) Port() int {
	if s.listener == nil {
		return 0
	}
	return s.listener.Addr().(*net.TCPAddr).Port
}

// Close stops serving.
func (s *Server) Close(ctx context.Context) error {
	return s.http.Shutdown(ctx)
}

// writeJSON sends a body, and never caches: every one of these is live.
func writeJSON(w http.ResponseWriter, status int, body any) {
	buf, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"error":"encoding failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
	w.WriteHeader(status)
	w.Write(buf)
}

// family reads the family filter, treating "all" and anything unknown as no
// filter at all.
func family(r *http.Request) gtfs.Family {
	switch f := gtfs.Family(r.URL.Query().Get("family")); f {
	case gtfs.FamilyTGV, gtfs.FamilyIC, gtfs.FamilyTER, gtfs.FamilyOther:
		return f
	default:
		return ""
	}
}

func intParam(r *http.Request, name string, fallback int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return fallback
	}
	return v
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.store.Stats())
}

// refresh forces an upstream retry, for when the feed has been down.
func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	err := s.store.Refresh(r.Context())
	body := struct {
		store.Stats
		Retried bool   `json:"retried"`
		Error   string `json:"error,omitempty"`
	}{Stats: s.store.Stats(), Retried: true}
	if err != nil {
		body.Error = err.Error()
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) trains(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.Filter{
		Family:   family(r),
		MinDelay: int64(intParam(r, "minDelay", 0)),
		Running:  q.Get("running") == "1",
		Query:    q.Get("q"),
	}
	// The map only needs a light payload — so build that, rather than
	// assembling every train's calls and history and dropping them here.
	if q.Get("light") == "1" {
		writeJSON(w, http.StatusOK, map[string]any{
			"feedTs": s.store.FeedTS(),
			"trains": s.store.LightList(f),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"feedTs": s.store.FeedTS(),
		"trains": s.store.List(f),
	})
}

func (s *Server) worst(w http.ResponseWriter, r *http.Request) {
	limit := min(50, max(1, intParam(r, "limit", 25)))
	writeJSON(w, http.StatusOK, s.store.Worst(limit))
}

func (s *Server) suggest(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.store.Suggest(
		r.URL.Query().Get("q"), family(r), intParam(r, "limit", 20)))
}

func (s *Server) railGeoJSON(w http.ResponseWriter, r *http.Request) {
	// The in-service network is not yet served by this build; the client
	// tolerates its absence by drawing no background rail layer.
	http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
}

var (
	trainPath = regexp.MustCompile(`^/api/train/([\w-]+)$`)
	pathPath  = regexp.MustCompile(`^/api/train/([\w-]+)/path$`)
)

// rest handles the per-train routes and then falls through to the bundle.
func (s *Server) rest(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path

	if m := pathPath.FindStringSubmatch(p); m != nil {
		hits := s.store.Find(m[1])
		if len(hits) == 0 {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "train not in the feed"})
			return
		}
		writeJSON(w, http.StatusOK, s.store.JourneyGeo(hits[0]))
		return
	}

	if m := trainPath.FindStringSubmatch(p); m != nil {
		number := m[1]
		hits := s.store.Find(number)
		if len(hits) == 0 {
			known, ok := s.store.KnownSchedule(number)
			reason, message := "unknown", "Unknown train number."
			if ok {
				reason = "dormant"
				message = "Not in the live feed right now — it runs outside the ~8 h forecast window, or not today."
			}
			body := map[string]any{
				"found": false, "number": number,
				"reason": reason, "message": message,
			}
			if ok {
				body["knownSchedule"] = known
			} else {
				body["knownSchedule"] = nil
			}
			writeJSON(w, http.StatusNotFound, body)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"found": true, "feedTs": s.store.FeedTS(), "trains": hits,
		})
		return
	}

	if strings.HasPrefix(p, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	s.serveStatic(w, r)
}
