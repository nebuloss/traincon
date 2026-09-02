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
	"slices"
	"sort"
	"strings"
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
	// Partners are the other numbers of the coupled set this train is running
	// in, when it is running in one.
	Partners []string
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
	// Partners is the rest of the coupled set, recorded here rather than looked
	// up when the board is read. Coupling is detected from the live feed, and
	// by the time anyone reads the day's ranking the train has usually finished
	// — the knowledge has to be written down while it is still there to have.
	Partners []string `json:"partners,omitempty"`
}

// Row is an Entry as the API serves it.
type Row struct {
	Entry
	Live   bool   `json:"live"`
	Status Status `json:"status"`
	Reason string `json:"reason,omitempty"`
	// CoupledWith is the rest of the set, under the name the browser already
	// uses for it: the row component labels a train "6173 + 6175" and tags it
	// UM from this field, so a merged row needs no rendering of its own.
	CoupledWith []string `json:"coupledWith,omitempty"`
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
		if seen && learnPartners(prev, t.Partners) {
			// Two portions from different origins are joined at an intermediate
			// stop, so a train can be half way through its run before it has a
			// partner at all — long after its peak was recorded.
			b.dirty = true
		}
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
		partners := t.Partners
		if seen {
			partners = prev.Partners
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
			Partners:     partners,
		}
		learnPartners(b.entries[t.Number], t.Partners)
		b.dirty = true
	}

	if len(b.entries) > maxEntries {
		b.trim()
	}
}

// learnPartners folds newly seen partners into an entry, and says whether that
// changed anything.
//
// A union rather than a replacement: a set is detected from the live feed and a
// portion can drop out of it — when it does, the fact that the two ran joined
// today is still true, and the ranking still has to merge them.
func learnPartners(e *Entry, add []string) bool {
	changed := false
	for _, n := range add {
		if n == e.Number || slices.Contains(e.Partners, n) {
			continue
		}
		e.Partners = append(e.Partners, n)
		changed = true
	}
	if changed {
		slices.Sort(e.Partners)
	}
	return changed
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
	// A coupled set is one physical train published under one number per
	// portion, so left alone it takes one line of the ranking per portion:
	// the same route, the same delay, twice. Merged first and then cut to the
	// limit, so the space a duplicate used to occupy goes to another train.
	done := make(map[string]bool, len(b.entries))
	rows := make([]Row, 0, limit)
	for _, e := range b.sorted() {
		if done[e.Number] {
			continue
		}
		numbers, members := b.setOf(e)
		for _, n := range numbers {
			done[n] = true
		}
		// sorted() is worst first, so the entry that reached the set is already
		// the one carrying its peak — no need to look for it again.
		rows = append(rows, merge(e, numbers, members, live, reason, now))
		if len(rows) == limit {
			break
		}
	}
	return rows
}

// setOf returns every number of the coupled set an entry belongs to, and the
// entries among them.
//
// Walked rather than read off one entry: partnerships are recorded per number
// and learnt from whichever end the feed revised first, so they cannot be
// assumed symmetric. A partner with no entry of its own — its delay never
// reached the board's threshold — still belongs to the set and still belongs
// in the label.
func (b *Board) setOf(e *Entry) ([]string, []*Entry) {
	seen := map[string]bool{e.Number: true}
	queue := []string{e.Number}
	numbers := make([]string, 0, 2)
	members := make([]*Entry, 0, 2)
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		numbers = append(numbers, n)
		m, ok := b.entries[n]
		if !ok {
			continue
		}
		members = append(members, m)
		for _, p := range m.Partners {
			if !seen[p] {
				seen[p] = true
				queue = append(queue, p)
			}
		}
	}
	slices.Sort(numbers)
	return numbers, members
}

// merge turns one coupled set into the single row it should have been.
//
// The delay is the lead entry's, which is the worst any portion recorded. That
// is what the board is — the day's high-water mark — and the reconciliation
// that stops a stale twin being believed has already been applied by the time
// a delay is observed, so the two portions are not disagreeing here.
func merge(lead *Entry, numbers []string, members []*Entry,
	live func(string) bool, reason func(string) string, now int64,
) Row {
	e := *lead
	e.Partners = nil

	anyLive, allCancelled := false, true
	for _, m := range members {
		if !m.Cancelled {
			allCancelled = false
		}
	}
	e.Cancelled = allCancelled
	// Portions that join partway can start from different places and, after a
	// split, end at different ones. Naming only the lead's would quietly drop
	// half the journey.
	e.Origin = span(members, func(m *Entry) string { return m.Origin })
	e.Destination = span(members, func(m *Entry) string { return m.Destination })

	// Any number still in the feed makes the row openable, and any that names
	// a cause explains it.
	why := ""
	for _, n := range numbers {
		if live(n) {
			anyLive = true
		}
		if why == "" {
			why = reason(n)
		}
	}

	with := make([]string, 0, len(numbers)-1)
	for _, n := range numbers {
		if n != e.Number {
			with = append(with, n)
		}
	}
	return Row{
		Entry:       e,
		Live:        anyLive,
		Status:      statusOf(&e, anyLive, now),
		Reason:      why,
		CoupledWith: with,
	}
}

// span names one end of a set's journey: the shared place, or each of them.
func span(members []*Entry, of func(*Entry) string) string {
	seen := make([]string, 0, len(members))
	for _, m := range members {
		if v := of(m); v != "" && !slices.Contains(seen, v) {
			seen = append(seen, v)
		}
	}
	return strings.Join(seen, " / ")
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
