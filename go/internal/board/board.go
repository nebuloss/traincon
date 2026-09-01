// Package board keeps the day's worst delays.
//
// The live store cannot answer this on its own: the feed is a rolling ~8 hour
// forward window and trains are pruned two hours after they leave it, so by
// evening the morning's disasters are long gone. This keeps a high-water mark
// per train for the current day instead — once a train has been 3 h 30 down it
// stays on the board even after it has finished its run and vanished.
//
// Persisted, because a restart mid-afternoon should not wipe the morning, and
// reset when the Paris date rolls over — the timetable's own day boundary.
package board

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"

	"traincon/internal/gtfs"
)

const (
	// minDelay is the threshold below which a train is not interesting enough
	// to record.
	minDelay = 10 * 60
	// maxEntries caps the board so a bad day cannot grow the file without
	// bound.
	maxEntries = 400
)

// Train is the little the board needs from a train.
//
// Deliberately not the full DTO: building those for the whole network on every
// refresh meant routing every train over the rail graph and materialising every
// call list, once a minute, to read six scalars. That is what pushed the heap
// past its ceiling and took the service down.
type Train struct {
	Number      string
	Service     string
	Origin      string
	Destination string
	Cancelled   bool
	WorstDelay  int64
	// FirstCall and LastCall are the scheduled ends of its run, so a row can
	// say why it is not live.
	FirstCall int64
	LastCall  int64
	HasCalls  bool
}

// Status says why a row is, or is not, live.
type Status string

// The states a board row can be in.
const (
	// Running: the train is in the feed now.
	Running Status = "running"
	// Upcoming: it has not left yet.
	Upcoming Status = "upcoming"
	// Finished: its run is over.
	Finished Status = "finished"
	// Gone: it is not in the feed and nothing more can be said. Entries saved
	// before the schedule was recorded fall back to this — true of anything
	// not in the feed, and never misleading.
	Gone Status = "gone"
)

// Entry is one train's worst showing today.
type Entry struct {
	Number       string      `json:"number"`
	ServiceLabel string      `json:"serviceLabel"`
	Family       gtfs.Family `json:"family"`
	Origin       string      `json:"origin"`
	Destination  string      `json:"destination"`
	// Delay is the worst seen today, in seconds, and At when that peak was
	// recorded.
	Delay     int64 `json:"delay"`
	At        int64 `json:"at"`
	Cancelled bool  `json:"cancelled"`
	StartsAt  int64 `json:"startsAt,omitempty"`
	EndsAt    int64 `json:"endsAt,omitempty"`
}

// Row is an Entry as the API serves it.
type Row struct {
	Entry
	Live   bool   `json:"live"`
	Status Status `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// Board is the day's high-water marks, persisted between restarts.
type Board struct {
	dataDir string
	entries map[string]*Entry
	day     string
	dirty   bool
}

// New returns an empty board backed by dataDir.
func New(dataDir string) *Board {
	return &Board{dataDir: dataDir, entries: make(map[string]*Entry)}
}

// paris is the timetable's own day boundary.
var paris = func() *time.Location {
	loc, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		// A machine without tzdata: UTC is wrong by an hour or two, which
		// moves the rollover but does not break the board.
		return time.UTC
	}
	return loc
}()

// Today is the current date in Paris, as YYYY-MM-DD.
func Today(now time.Time) string {
	return now.In(paris).Format("2006-01-02")
}

func (b *Board) file() string { return filepath.Join(b.dataDir, "daily-board.json") }

// Day reports which date the board currently holds.
func (b *Board) Day() string { return b.day }

// Size reports how many trains are on the board.
func (b *Board) Size() int { return len(b.entries) }

type stored struct {
	Day     string  `json:"day"`
	Entries []Entry `json:"entries"`
}

// Load reads the persisted board, if it is today's.
func (b *Board) Load() error {
	b.day = Today(time.Now())
	body, err := os.ReadFile(b.file())
	if errors.Is(err, os.ErrNotExist) {
		return nil // first run
	}
	if err != nil {
		return err
	}
	var raw stored
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil // unreadable: start empty rather than refuse to boot
	}
	// Yesterday's board is not today's: start clean rather than showing stale
	// records under today's heading.
	if raw.Day != b.day {
		return nil
	}
	for i := range raw.Entries {
		e := raw.Entries[i]
		b.entries[e.Number] = &e
	}
	return nil
}

// Observe folds the current snapshot into the day's records.
func (b *Board) Observe(trains []Train, now int64) {
	if today := Today(time.Unix(now, 0)); today != b.day {
		b.day = today
		clear(b.entries)
		b.dirty = true
	}

	for _, t := range trains {
		// A cancelled train has no meaningful delay but absolutely belongs.
		if !t.Cancelled && t.WorstDelay < minDelay {
			continue
		}

		prev, seen := b.entries[t.Number]
		if seen && !t.Cancelled && t.WorstDelay <= prev.Delay {
			// The peak has not moved, so the entry stands — but one written
			// before the schedule was recorded cannot say whether the train has
			// finished or not left yet. Fill it in while the train is still in
			// the feed to be asked; once it drops out the chance is gone.
			if prev.StartsAt == 0 && t.HasCalls {
				prev.StartsAt, prev.EndsAt = t.FirstCall, t.LastCall
				b.dirty = true
			}
			continue
		}

		meta := gtfs.Service(t.Service)
		delay, at := t.WorstDelay, now
		cancelled := t.Cancelled
		if seen {
			if prev.Delay > delay {
				delay, at = prev.Delay, prev.At
			}
			cancelled = cancelled || prev.Cancelled
		}
		b.entries[t.Number] = &Entry{
			Number:       t.Number,
			ServiceLabel: meta.Label,
			Family:       meta.Family,
			Origin:       t.Origin,
			Destination:  t.Destination,
			Delay:        delay,
			At:           at,
			Cancelled:    cancelled,
			StartsAt:     t.FirstCall,
			EndsAt:       t.LastCall,
		}
		b.dirty = true
	}

	if len(b.entries) > maxEntries {
		b.trim()
	}
}

// trim keeps only the worst, so the file stays small on a bad day.
func (b *Board) trim() {
	kept := b.sorted()
	if len(kept) > maxEntries {
		kept = kept[:maxEntries]
	}
	b.entries = make(map[string]*Entry, len(kept))
	for _, e := range kept {
		b.entries[e.Number] = e
	}
}

// sorted returns the entries worst first, ties broken by number so the order is
// stable between refreshes.
func (b *Board) sorted() []*Entry {
	out := make([]*Entry, 0, len(b.entries))
	for _, e := range b.entries {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Delay != out[j].Delay {
			return out[i].Delay > out[j].Delay
		}
		return out[i].Number < out[j].Number
	})
	return out
}

// Top is the ranking, worst first.
//
// live and reason are supplied by the caller, which owns the current snapshot
// and the disruption index.
func (b *Board) Top(limit int, live func(string) bool, reason func(string) string, now int64) []Row {
	ranked := b.sorted()
	if limit < len(ranked) {
		ranked = ranked[:limit]
	}
	rows := make([]Row, 0, len(ranked))
	for _, e := range ranked {
		isLive := live(e.Number)
		rows = append(rows, Row{
			Entry:  *e,
			Live:   isLive,
			Status: statusOf(e, isLive, now),
			Reason: reason(e.Number),
		})
	}
	return rows
}

// statusOf says why a row is, or is not, live.
//
// Most of the board is history, and a row you cannot open should say which kind
// it is rather than merely failing to respond.
func statusOf(e *Entry, live bool, now int64) Status {
	switch {
	case live:
		return Running
	case e.StartsAt != 0 && e.StartsAt > now:
		return Upcoming
	case e.EndsAt != 0 && e.EndsAt <= now:
		return Finished
	default:
		return Gone
	}
}

// Save writes the board out, if anything has changed since the last write.
func (b *Board) Save() error {
	if !b.dirty {
		return nil
	}
	b.dirty = false
	entries := make([]Entry, 0, len(b.entries))
	for _, e := range b.sorted() {
		entries = append(entries, *e)
	}
	body, err := json.Marshal(stored{Day: b.day, Entries: entries})
	if err != nil {
		return err
	}
	return os.WriteFile(b.file(), body, 0o644)
}
