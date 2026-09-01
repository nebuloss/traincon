// Package coupling detects units running joined together — unité multiple.
//
// Two portions from different origins are routinely joined at an intermediate
// stop and run to the terminus as one physical train, keeping separate numbers.
// SNCF publishes a record per number and updates them independently, so one goes
// stale: 8540 sat at +70 all the way to Paris while its twin 8582 had already
// been corrected to +50 — the figure SNCF Connect showed, and the one that
// matched reality.
//
// This finds those sets and reconciles them.
package coupling

import (
	"slices"
	"sort"

	"traincon/internal/feed"
	"traincon/internal/rail"
	"traincon/internal/train"
)

const (
	// delayTol is generous, deliberately: the point is to reconcile numbers
	// that disagree.
	delayTol = 40 * 60
	// schedTol is how close to each other two services must be booked into the
	// terminus to be the same physical train.
	schedTol = 4 * 60
	// disagreementMin is the spread below which the numbers agree well enough
	// not to flag it.
	disagreementMin = 5 * 60
)

// Disagreement is one number of a coupled set differing from its twin.
type Disagreement struct {
	Number string `json:"number"`
	Delay  int64  `json:"delay"`
}

// Reconciliation is the delay a coupled set settled on, and the disagreement
// behind it.
type Reconciliation struct {
	Delay int64 `json:"delay"`
	// Source is the number whose prediction was revised most recently.
	Source       string         `json:"source"`
	Spread       int64          `json:"spread"`
	Disagreement []Disagreement `json:"disagreement"`
}

// Result is what one pass of the detector found.
type Result struct {
	// Partners maps a number to the other numbers of its set.
	Partners map[string][]string
	// Positions maps a number to the position shared by the whole set.
	Positions map[string]train.Position
	// Delays maps a number to its reconciled delay.
	Delays map[string]Reconciliation
	// Calls maps a number to its calls with the shared tail corrected from the
	// freshest member.
	Calls map[string][]feed.Call
}

func newResult() *Result {
	return &Result{
		Partners:  make(map[string][]string),
		Positions: make(map[string]train.Position),
		Delays:    make(map[string]Reconciliation),
		Calls:     make(map[string][]feed.Call),
	}
}

// Detector tracks how recently each number's delay was revised, across
// refreshes, so the freshest member of a set can be identified.
type Detector struct {
	lastChange map[string]int64
}

// New returns an empty Detector.
func New() *Detector {
	return &Detector{lastChange: make(map[string]int64)}
}

// NoteChange records that a number's delay changed, so freshness can be
// compared later.
func (d *Detector) NoteChange(number string, feedTS int64) {
	d.lastChange[number] = feedTS
}

// Forget drops a train that has left the feed, so the map stays bounded.
func (d *Detector) Forget(number string) {
	delete(d.lastChange, number)
}

// Size reports how many numbers are tracked, for the memory diagnostics.
func (d *Detector) Size() int { return len(d.lastChange) }

// member is one candidate portion.
type member struct {
	train *train.Train
	delay int64
	// schedTerminus is the scheduled arrival at the terminus, stable whatever
	// the live times say.
	schedTerminus int64
	// toward is the stop the train is heading for.
	toward string
	// legF is the fraction along the current leg, for picking the most
	// advanced member.
	legF float64
}

// Detect finds coupled sets among the running trains and reconciles them.
func (d *Detector) Detect(trains []*train.Train, now int64, g *rail.Graph, cache *rail.Cache) *Result {
	buckets := make(map[string][]member)
	for _, t := range trains {
		if _, ok := t.NextCall(now); !ok {
			continue
		}
		leg := t.LegAt(now)
		if leg.Basis != train.Between && leg.Basis != train.AtStation {
			continue
		}
		// Bucket on the terminus, refined below by its scheduled arrival
		// minute. Two services booked into the same terminus at the same
		// minute, heading for the same next stop, are one physical train.
		// Keying on the remaining call sequence fails: the feed had 8540 still
		// standing at Bordeaux while 8582 had departed, so one had two calls
		// left and the other one.
		last := t.Terminus()
		buckets[last.StopID] = append(buckets[last.StopID], member{
			train:         t,
			delay:         t.CurrentDelay(now),
			schedTerminus: last.Time - last.Delay,
			toward:        leg.B.StopID,
			legF:          leg.F,
		})
	}

	out := newResult()
	for _, group := range buckets {
		if len(group) < 2 {
			continue
		}
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].schedTerminus != group[j].schedTerminus {
				return group[i].schedTerminus < group[j].schedTerminus
			}
			return group[i].delay < group[j].delay
		})

		run := []member{group[0]}
		for _, cur := range group[1:] {
			prev := run[len(run)-1]
			closeDelay := abs64(cur.delay-prev.delay) <= delayTol
			sameSlot := abs64(cur.schedTerminus-prev.schedTerminus) <= schedTol
			if closeDelay && sameSlot && cur.toward == prev.toward {
				run = append(run, cur)
				continue
			}
			d.reconcile(run, now, g, cache, out)
			run = []member{cur}
		}
		d.reconcile(run, now, g, cache, out)
	}
	return out
}

// reconcile settles one coupled set on a single position, delay and timetable.
func (d *Detector) reconcile(run []member, now int64, g *rail.Graph, cache *rail.Cache, out *Result) {
	if len(run) < 2 {
		return
	}
	numbers := make([]string, len(run))
	for i, m := range run {
		numbers[i] = m.train.Number
	}

	// One physical train, one position: take the most advanced reading, since a
	// set that has reached a point has reached it under every number.
	lead := run[0]
	for _, m := range run[1:] {
		if m.legF > lead.legF {
			lead = m
		}
	}
	position := lead.train.PositionAt(now, g, cache)

	// One physical train cannot have two delays. Trust the number whose
	// prediction was revised most recently.
	freshest := run[0]
	for _, m := range run[1:] {
		if d.lastChange[m.train.Number] > d.lastChange[freshest.train.Number] {
			freshest = m
		}
	}

	lo, hi := run[0].delay, run[0].delay
	for _, m := range run {
		lo = min(lo, m.delay)
		hi = max(hi, m.delay)
	}
	spread := hi - lo
	var disagreement []Disagreement
	if spread >= disagreementMin {
		for _, m := range run {
			disagreement = append(disagreement, Disagreement{Number: m.train.Number, Delay: m.delay})
		}
	}

	// Fixing only the headline figure leaves the timeline lying: 8540 showed
	// "50 min" above a stop list still reading Bordeaux 16:50 / Paris 19:06,
	// while 8582 had 16:30 / 18:46 — exactly what SNCF Connect displayed. Once
	// the portions have joined they call at the same stops at the same moment,
	// so the shared tail takes the freshest member's times.
	src := make(map[string]feed.Call, len(freshest.train.Calls))
	for _, c := range freshest.train.Calls {
		src[c.StopID] = c
	}
	joinTime := freshest.train.LegAt(now).A.Time

	for _, m := range run {
		n := m.train.Number
		others := make([]string, 0, len(numbers)-1)
		for _, o := range numbers {
			if o != n {
				others = append(others, o)
			}
		}
		out.Partners[n] = others
		out.Positions[n] = position
		out.Delays[n] = Reconciliation{
			Delay:        freshest.delay,
			Source:       freshest.train.Number,
			Spread:       spread,
			Disagreement: disagreement,
		}

		if n == freshest.train.Number {
			continue
		}
		corrected := slices.Clone(m.train.Calls)
		for i, c := range corrected {
			// Only from the join onward: each portion's own earlier stops
			// (Hendaye against Tarbes here) are genuinely its own.
			if s, ok := src[c.StopID]; ok && s.Time >= joinTime {
				corrected[i] = s
			}
		}
		out.Calls[n] = corrected
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
