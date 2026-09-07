package board

import (
	"testing"
	"time"
)

func late(number string, delay int64) Train {
	return Train{
		Number: number, Service: "OUI", Origin: "A", Destination: "B",
		WorstDelay: delay, FirstCall: 1000, LastCall: 2000, HasCalls: true,
	}
}

func noLive(string) bool     { return false }
func noReason(string) string { return "" }

func TestOnlySubstantialDelaysAreRecorded(t *testing.T) {
	b := New(t.TempDir())
	b.Observe([]Train{late("1", 9*60), late("2", 11*60)}, 5000)
	if b.Size() != 1 {
		t.Errorf("recorded %d trains, want 1 — nine minutes is not interesting", b.Size())
	}
}

func TestACancelledTrainBelongsWhateverItsDelay(t *testing.T) {
	// It has no meaningful delay, but it is exactly what the board is for.
	b := New(t.TempDir())
	cancelled := late("1", 0)
	cancelled.Cancelled = true
	b.Observe([]Train{cancelled}, 5000)
	if b.Size() != 1 {
		t.Fatal("a cancelled train was not recorded")
	}
	if !b.Top(10, noLive, noReason, 5000)[0].Cancelled {
		t.Error("the row does not say it was cancelled")
	}
}

func TestTheBoardKeepsTheHighWaterMark(t *testing.T) {
	// Once a train has been 3 h 30 down it stays down, even if it recovers:
	// the feed is a rolling window and by evening the morning is gone.
	b := New(t.TempDir())
	b.Observe([]Train{late("1", 3*3600)}, 1000)
	b.Observe([]Train{late("1", 600)}, 2000) // recovered
	rows := b.Top(10, noLive, noReason, 5000)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].Delay != 3*3600 {
		t.Errorf("delay = %d, want the peak of %d", rows[0].Delay, 3*3600)
	}
	if rows[0].At != 1000 {
		t.Errorf("peak recorded at %d, want 1000 — when it actually happened", rows[0].At)
	}
}

func TestAWorseShowingMovesThePeak(t *testing.T) {
	b := New(t.TempDir())
	b.Observe([]Train{late("1", 600)}, 1000)
	b.Observe([]Train{late("1", 3600)}, 2000)
	rows := b.Top(10, noLive, noReason, 5000)
	if rows[0].Delay != 3600 || rows[0].At != 2000 {
		t.Errorf("got %d s at %d, want 3600 at 2000", rows[0].Delay, rows[0].At)
	}
}

func TestTheScheduleIsFilledInWhileTheTrainCanStillBeAsked(t *testing.T) {
	// An entry written before the schedule was recorded cannot say whether the
	// train has finished or has not left; once it drops out of the feed the
	// chance is gone for the day.
	b := New(t.TempDir())
	noSchedule := late("1", 3600)
	noSchedule.HasCalls = false
	noSchedule.FirstCall, noSchedule.LastCall = 0, 0
	b.Observe([]Train{noSchedule}, 1000)
	if got := b.Top(1, noLive, noReason, 5000)[0].StartsAt; got != 0 {
		t.Fatalf("StartsAt = %d, want it unset", got)
	}

	// The same train later, with its schedule, and no worse than before.
	b.Observe([]Train{late("1", 600)}, 2000)
	if got := b.Top(1, noLive, noReason, 5000)[0].StartsAt; got != 1000 {
		t.Errorf("StartsAt = %d, want 1000 — filled in from the later sighting", got)
	}
}

func TestRankingIsWorstFirstAndStable(t *testing.T) {
	b := New(t.TempDir())
	b.Observe([]Train{late("b", 3600), late("a", 3600), late("c", 7200)}, 1000)
	rows := b.Top(10, noLive, noReason, 5000)
	if rows[0].Number != "c" {
		t.Errorf("worst is %q, want c", rows[0].Number)
	}
	// Equal delays break on the number, so the order does not shuffle between
	// refreshes.
	if rows[1].Number != "a" || rows[2].Number != "b" {
		t.Errorf("tie order = %q,%q, want a,b", rows[1].Number, rows[2].Number)
	}
}

func TestStatusSaysWhyARowIsNotLive(t *testing.T) {
	// A row you cannot open should say which kind it is rather than merely
	// failing to respond.
	e := &Entry{StartsAt: 1000, EndsAt: 2000}
	tests := []struct {
		name string
		live bool
		now  int64
		want Status
	}{
		{"in the feed", true, 1500, Running},
		{"not left yet", false, 500, Upcoming},
		{"run is over", false, 2500, Finished},
		{"mid-run but absent", false, 1500, Gone},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := statusOf(e, tc.live, tc.now); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestStatusWithoutASchedule(t *testing.T) {
	// Entries saved before the schedule was recorded fall back to gone, which
	// is true of anything not in the feed and never misleading.
	if got := statusOf(&Entry{}, false, 1000); got != Gone {
		t.Errorf("got %q, want gone", got)
	}
}

func TestTheBoardIsCappedOnABadDay(t *testing.T) {
	b := New(t.TempDir())
	var many []Train
	for i := range maxEntries + 50 {
		many = append(many, late(string(rune('a'+i%26))+string(rune('a'+i/26)), int64(600+i)))
	}
	b.Observe(many, 1000)
	if b.Size() > maxEntries {
		t.Errorf("board holds %d, want no more than %d", b.Size(), maxEntries)
	}
	// And what it kept is the worst of them.
	rows := b.Top(1, noLive, noReason, 5000)
	if rows[0].Delay != int64(600+maxEntries+49) {
		t.Errorf("kept a peak of %d, want the worst %d", rows[0].Delay, 600+maxEntries+49)
	}
}

func TestTheDayRollingOverClearsTheBoard(t *testing.T) {
	// Reset on the Paris date, which is the timetable's own boundary.
	b := New(t.TempDir())
	b.day = "2026-08-31"
	b.Observe([]Train{late("1", 3600)}, time.Date(2026, 9, 1, 12, 0, 0, 0, paris).Unix())
	if b.Day() != "2026-09-01" {
		t.Errorf("day = %q, want 2026-09-01", b.Day())
	}
	if b.Size() != 1 {
		t.Errorf("the new day holds %d entries, want just the one observed", b.Size())
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	// A restart mid-afternoon must not wipe the morning.
	dir := t.TempDir()
	first := New(dir)
	if err := first.Load(); err != nil {
		t.Fatalf("Load on an empty directory: %v", err)
	}
	first.Observe([]Train{late("1", 3*3600)}, time.Now().Unix())
	if err := first.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	second := New(dir)
	if err := second.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if second.Size() != 1 {
		t.Fatalf("reloaded %d entries, want 1", second.Size())
	}
	if got := second.Top(1, noLive, noReason, time.Now().Unix())[0].Delay; got != 3*3600 {
		t.Errorf("reloaded delay = %d, want %d", got, 3*3600)
	}
}

func TestYesterdaysFileIsNotTodaysBoard(t *testing.T) {
	dir := t.TempDir()
	stale := New(dir)
	stale.day = "2000-01-01"
	stale.Observe([]Train{late("1", 3600)}, time.Date(2000, 1, 1, 12, 0, 0, 0, paris).Unix())
	if err := stale.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	today := New(dir)
	if err := today.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if today.Size() != 0 {
		t.Errorf("loaded %d stale entries under today's heading", today.Size())
	}
}

func TestSaveIsSkippedWhenNothingChanged(t *testing.T) {
	b := New(t.TempDir())
	if err := b.Save(); err != nil {
		t.Errorf("Save on a clean board: %v", err)
	}
	// Nothing was written, so loading finds nothing.
	again := New(b.dataDir)
	if err := again.Load(); err != nil {
		t.Errorf("Load: %v", err)
	}
	if again.Size() != 0 {
		t.Error("a clean board wrote a file")
	}
}
