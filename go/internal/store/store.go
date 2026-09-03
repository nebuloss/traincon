// Package store holds the live picture of the network: what the feed said, what
// it implies, and everything the API serves from it.
//
// One goroutine polls; requests read. A mutex guards the swap, so a request
// either sees the previous refresh whole or the next one whole, never half of
// each.
package store

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"traincon/internal/blocks"
	"traincon/internal/board"
	"traincon/internal/coupling"
	"traincon/internal/disruptions"
	"traincon/internal/feed"
	"traincon/internal/gtfs"
	"traincon/internal/headway"
	"traincon/internal/rail"
	"traincon/internal/signals"
	"traincon/internal/train"
)

const (
	// pollEvery is how often the feed is re-read.
	pollEvery = time.Minute
	// historyMax is how many delay revisions to keep per train.
	historyMax = 60
	// pruneAfter is how long a train's history outlives its last sighting.
	//
	// Trains drop out of the feed briefly, so pruning to the current set on
	// every refresh would forget one that is merely between updates.
	pruneAfter = 2 * time.Hour
	// defaultBlockM stands in where the block-working table is not available:
	// 1 800 m is a typical lit block.
	defaultBlockM = 1800
)

// DelaySample is one revision of a train's delay.
type DelaySample struct {
	T     int64 `json:"t"`
	Delay int64 `json:"delay"`
}

// Trend is which way a delay is moving.
type Trend string

// The trends a train can show.
const (
	Worsening  Trend = "worsening"
	Recovering Trend = "recovering"
	Stable     Trend = "stable"
)

// Store is the live picture of the network.
type Store struct {
	dataDir string

	feed        *feed.Client
	board       *board.Board
	coupling    *coupling.Detector
	disruptions *disruptions.Index

	// Reference data, loaded once at start.
	statics *gtfs.Static
	graph   *rail.Graph
	blocks  *blocks.Index
	signals *signals.Index
	paths   *rail.Cache

	mu       sync.RWMutex
	trains   []*train.Train
	byNumber map[string][]*train.Train
	couples  *coupling.Result
	traffic  map[string]headway.Traffic
	history  map[string][]DelaySample
	lastSeen map[string]time.Time

	feedTS    int64
	fetchedAt int64
	replay    bool
	err       string

	stop chan struct{}
	once sync.Once
}

// New returns a store backed by dataDir. Nothing is loaded until Start.
func New(dataDir string) *Store {
	return &Store{
		dataDir:     dataDir,
		feed:        feed.New(),
		board:       board.New(dataDir),
		coupling:    coupling.New(),
		disruptions: disruptions.New(),
		paths:       rail.NewCache(),
		byNumber:    make(map[string][]*train.Train),
		couples:     &coupling.Result{},
		traffic:     make(map[string]headway.Traffic),
		history:     make(map[string][]DelaySample),
		lastSeen:    make(map[string]time.Time),
		stop:        make(chan struct{}),
	}
}

// Start loads the reference data and takes the first reading, then begins
// polling in the background.
//
// A transient feed failure must not stop the server coming up: the error is
// recorded, the last snapshot is served if there is one, and the poller takes
// over.
func (s *Store) Start(ctx context.Context) error {
	var err error
	if s.statics, err = gtfs.Load(ctx, s.dataDir); err != nil {
		return err
	}
	// Coupling is what the timetable books, not what the live feed suggests.
	s.coupling.Declare(s.statics)
	if err := s.board.Load(); err != nil {
		slog.Warn("board: could not be loaded", "err", err)
	}
	// Spacing and signalling are refinements: without them every train is
	// placed as if the line were empty, which is what it did before.
	if s.blocks, err = blocks.Load(s.dataDir); err != nil {
		slog.Warn("blocks: could not be loaded", "err", err)
	}
	if s.signals, err = signals.Load(s.dataDir); err != nil {
		slog.Warn("signals: could not be loaded", "err", err)
	}
	if s.graph, err = rail.Load(s.dataDir); err != nil {
		slog.Warn("rail geometry unavailable, falling back to straight lines", "err", err)
	}
	s.disruptions.Start(ctx)

	if err := s.Refresh(ctx); err != nil {
		s.setError(err)
		slog.Warn("real-time feed unavailable at boot", "err", err)
		if n := s.loadSnapshot(); n > 0 {
			slog.Warn("resuming from the last snapshot", "trains", n)
		}
	}

	go s.poll(ctx)
	return nil
}

// Stop ends the background work.
func (s *Store) Stop() {
	s.once.Do(func() {
		close(s.stop)
		s.disruptions.Stop()
	})
}

func (s *Store) poll(ctx context.Context) {
	t := time.NewTicker(pollEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-t.C:
			if err := s.Refresh(ctx); err != nil {
				s.setError(err)
			}
		}
	}
}

func (s *Store) setError(err error) {
	s.mu.Lock()
	s.err = err.Error()
	s.mu.Unlock()
}

// Refresh reads the feed and rebuilds everything derived from it.
func (s *Store) Refresh(ctx context.Context) error {
	// The static tables are reloaded when they pass their age. Everything
	// about how that reload is written is in gtfs.MaxAge: it used to allocate
	// more than the heap had left, and killed the process every twelve hours.
	if s.statics.Stale() {
		if next, err := gtfs.Load(ctx, s.dataDir); err == nil {
			s.mu.Lock()
			s.statics = next
			s.mu.Unlock()
			// The declared sets belong to the tables that were just replaced.
			s.coupling.Declare(next)
		} // keep the old tables on failure
	}

	res, err := s.feed.Load(ctx, s.statics)
	if err != nil {
		return err
	}
	now := time.Now().Unix()

	trains := make([]*train.Train, 0, len(res.Trains))
	for _, raw := range res.Trains {
		trains = append(trains, train.FromFeed(raw))
	}

	byNumber := make(map[string][]*train.Train, len(trains))
	for _, t := range trains {
		byNumber[t.Number] = append(byNumber[t.Number], t)
	}

	s.mu.Lock()
	s.trains, s.byNumber = trains, byNumber
	s.feedTS, s.fetchedAt, s.replay, s.err = res.FeedTS, time.Now().UnixMilli(), res.Replay, ""

	for _, t := range trains {
		cur := t.CurrentDelay(now)
		h := s.history[t.Number]
		if len(h) == 0 || h[len(h)-1].Delay != cur {
			h = append(h, DelaySample{T: res.FeedTS, Delay: cur})
			if len(h) > historyMax {
				h = h[len(h)-historyMax:]
			}
			s.history[t.Number] = h
			s.coupling.NoteChange(t.Number, res.FeedTS)
		}
	}
	s.mu.Unlock()

	couples := s.coupling.Detect(trains, now, s.graph, s.paths)
	traffic := s.analyseSpacing(trains, couples, now)

	s.mu.Lock()
	s.couples, s.traffic = couples, traffic
	s.mu.Unlock()

	// Record the day's worst before pruning drops anything. The raw trains,
	// not the DTOs: building those routes every train over the rail graph, and
	// doing it every minute exhausted the heap.
	s.board.Observe(boardTrains(trains, couples), now)
	if err := s.board.Save(); err != nil {
		slog.Warn("board: could not be saved", "err", err)
	}

	s.prune()
	s.saveSnapshot()
	return nil
}

func boardTrains(trains []*train.Train, couples *coupling.Result) []board.Train {
	out := make([]board.Train, 0, len(trains))
	for _, t := range trains {
		// The record to believe. SNCF publishes one per number of a coupled set
		// and revises them independently, so one goes stale — that is the whole
		// reason the detector exists. The reconciled calls are the freshest
		// member's, which is the figure the app shows; the day's ranking should
		// be recording the same one rather than a twin nobody was shown.
		src := t
		if calls, ok := couples.Calls[t.Number]; ok {
			src = t.WithCalls(calls)
		}
		bt := board.Train{
			Number: t.Number, Service: t.Service,
			Origin: t.Origin(), Destination: t.Destination(),
			Cancelled: t.Cancelled, WorstDelay: src.WorstDelay(),
			Partners: couples.Partners[t.Number],
		}
		if len(src.Calls) > 0 {
			bt.FirstCall, bt.LastCall, bt.HasCalls = src.Calls[0].Time, src.Terminus().Time, true
		}
		out = append(out, bt)
	}
	return out
}

// prune forgets trains that have left the feed.
//
// The history and coupling maps are keyed by train number and were only ever
// added to, so a long-running process accumulated every service of every day it
// had been up.
func (s *Store) prune() {
	s.mu.Lock()
	defer s.mu.Unlock()

	live := make(map[string]struct{}, len(s.trains))
	now := time.Now()
	for _, t := range s.trains {
		live[t.Number] = struct{}{}
		s.lastSeen[t.Number] = now
	}
	for n, at := range s.lastSeen {
		if _, still := live[n]; still || now.Sub(at) < pruneAfter {
			continue
		}
		delete(s.lastSeen, n)
		delete(s.history, n)
		s.coupling.Forget(n)
	}
}

// analyseSpacing works out what the traffic ahead implies for each train.
func (s *Store) analyseSpacing(trains []*train.Train, couples *coupling.Result, now int64) map[string]headway.Traffic {
	// Either source will do. The signalling layer is the better one — it gives
	// the real distance to the signal that would stop the train — and the
	// block-working mode is the fallback where it has nothing.
	if s.signals == nil && s.blocks == nil {
		return map[string]headway.Traffic{}
	}

	followers := make([]headway.Follower, 0, len(trains))
	for _, t := range trains {
		if t.Line == "" {
			continue
		}
		leg := t.LegAt(now)
		if leg.Basis != train.Between {
			continue
		}
		pos := legMidpoint(t, leg)
		// Group on the infrastructure line, not the commercial one: two trains
		// sharing a track routinely carry different service labels, so
		// grouping by those found almost no pairs at all.
		line := s.signals.LineAt(pos.Lat, pos.Lon, 2)
		if line == "" {
			line = t.Line
		}
		followers = append(followers, headway.Follower{
			Number:      t.Number,
			Line:        line,
			CoupledWith: couples.Partners[t.Number],
			Position:    pos,
		})
	}

	spacing := func(lat, lon float64) float64 {
		if s.blocks == nil {
			return defaultBlockM
		}
		return s.blocks.SpacingNear(lat, lon)
	}
	var nextSignal headway.SignalFunc
	var layout headway.LayoutFunc
	if s.signals != nil {
		nextSignal = func(lat, lon, bearing float64) (headway.Signal, bool) {
			ahead, ok := s.signals.NextAhead(lat, lon, bearing, 8, "")
			if !ok {
				return headway.Signal{}, false
			}
			// CARRE is the absolute stop and shows two reds; S is the
			// sémaphore, one red and a lit œilleton saying it may be passed.
			return headway.Signal{M: ahead.DistanceM, Kind: ahead.Signal.Kind()}, true
		}
		layout = func(lat, lon float64) headway.Layout {
			l := s.signals.TracksNear(lat, lon)
			return headway.Layout{Single: l.Single, Tracks: l.Tracks}
		}
	}
	return headway.Analyse(followers, spacing, nextSignal, layout)
}

// snapshotFile is where the last good reading is kept.
//
// Replay writes to its own file: a development session must never overwrite the
// production cache with time-shifted fixture data.
func (s *Store) snapshotFile() string {
	if os.Getenv("SNCF_FEED_FILE") != "" {
		return filepath.Join(s.dataDir, "last-feed.replay.json")
	}
	return filepath.Join(s.dataDir, "last-feed.json")
}
