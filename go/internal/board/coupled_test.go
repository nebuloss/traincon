package board

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A coupled set is one physical train published under one number per portion.
// Left alone it takes one line of the day's ranking per portion — the same
// route and the same delay, twice — which is what the palmarès showed.

func coupled(number string, delay int64, partners ...string) Train {
	t := late(number, delay)
	t.Partners = partners
	return t
}

func TestTwoPortionsAreOneLine(t *testing.T) {
	b := New(t.TempDir())
	b.Observe([]Train{
		coupled("6173", 60*60, "6175"),
		coupled("6175", 60*60, "6173"),
		late("9999", 30*60),
	}, 5000)

	rows := b.Top(25, noLive, noReason, 5000)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2 — the pair is one train", len(rows))
	}
	if rows[0].Number != "6173" {
		t.Errorf("led by %s, want the portion carrying the peak", rows[0].Number)
	}
	if len(rows[0].CoupledWith) != 1 || rows[0].CoupledWith[0] != "6175" {
		t.Errorf("coupledWith = %v, want [6175] so the row can be labelled", rows[0].CoupledWith)
	}
	if rows[1].Number != "9999" {
		t.Errorf("second row is %s, want the next real train", rows[1].Number)
	}
}

func TestMergingFreesAPlaceInTheRanking(t *testing.T) {
	// The limit is a number of trains, not a number of records. A merged pair
	// that still took two places would be no better than not merging at all.
	b := New(t.TempDir())
	b.Observe([]Train{
		coupled("1", 90*60, "2"),
		coupled("2", 90*60, "1"),
		late("3", 60*60),
		late("4", 50*60),
	}, 5000)

	rows := b.Top(3, noLive, noReason, 5000)
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	if rows[2].Number != "4" {
		t.Errorf("third row is %s, want 4 — the freed place goes to another train", rows[2].Number)
	}
}

func TestAPartnershipIsLearntFromEitherEnd(t *testing.T) {
	// The feed revises the two numbers independently, so whichever is seen
	// first names the other. The set has to close either way.
	b := New(t.TempDir())
	b.Observe([]Train{coupled("8540", 70*60, "8582"), late("8582", 50*60)}, 5000)

	rows := b.Top(25, noLive, noReason, 5000)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 — one of them named the other", len(rows))
	}
	if len(rows[0].CoupledWith) != 1 || rows[0].CoupledWith[0] != "8582" {
		t.Errorf("coupledWith = %v, want [8582]", rows[0].CoupledWith)
	}
}

func TestAPartnershipIsLearntAfterThePeak(t *testing.T) {
	// Two portions from different origins are joined at an intermediate stop,
	// so a train can be most of the way through its run before it has a partner
	// at all — long after its worst delay was recorded.
	b := New(t.TempDir())
	b.Observe([]Train{late("1", 60*60), late("2", 60*60)}, 5000)
	if len(b.Top(25, noLive, noReason, 5000)) != 2 {
		t.Fatal("they are two trains until they are joined")
	}

	b.Observe([]Train{coupled("1", 20*60, "2"), coupled("2", 20*60, "1")}, 6000)
	rows := b.Top(25, noLive, noReason, 6000)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 once the joining is known", len(rows))
	}
	if rows[0].Delay != 60*60 {
		t.Errorf("delay %d, want the peak either portion reached", rows[0].Delay)
	}
}

func TestAPortionThatUncouplesStaysMerged(t *testing.T) {
	// They ran joined today, and the day's ranking is about today. Dropping the
	// partnership the moment the feed stops reporting it would put the two rows
	// back the instant they split.
	b := New(t.TempDir())
	b.Observe([]Train{coupled("1", 60*60, "2"), coupled("2", 60*60, "1")}, 5000)
	b.Observe([]Train{late("1", 80*60), late("2", 80*60)}, 6000)

	if rows := b.Top(25, noLive, noReason, 6000); len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 — they were joined earlier today", len(rows))
	}
}

func TestJoinedPortionsNameBothEnds(t *testing.T) {
	// Portions from different origins are the ordinary case, not the odd one:
	// naming only the lead's would quietly drop half the journey.
	b := New(t.TempDir())
	nice := coupled("5772", 60*60, "5792")
	nice.Origin = "Nice-Ville"
	briancon := coupled("5792", 50*60, "5772")
	briancon.Origin = "Briançon"
	b.Observe([]Train{nice, briancon}, 5000)

	rows := b.Top(25, noLive, noReason, 5000)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].Origin != "Nice-Ville / Briançon" {
		t.Errorf("origin %q, want both portions named", rows[0].Origin)
	}
	if rows[0].Destination != "B" {
		t.Errorf("destination %q, want the one they share", rows[0].Destination)
	}
}

func TestASetIsLiveIfAnyOfItIs(t *testing.T) {
	// One physical train: if any number of it is still in the feed, the row can
	// be opened and the train watched.
	b := New(t.TempDir())
	b.Observe([]Train{coupled("1", 60*60, "2"), coupled("2", 60*60, "1")}, 5000)

	only2 := func(n string) bool { return n == "2" }
	rows := b.Top(25, only2, noReason, 5000)
	if !rows[0].Live {
		t.Error("the set should be live: one of its numbers is")
	}
	if rows[0].Status != Running {
		t.Errorf("status %q, want running", rows[0].Status)
	}
}

func TestASetIsCancelledOnlyIfAllOfItIs(t *testing.T) {
	// Half a train cancelled is not a cancelled train, and saying so would be
	// worse than saying nothing.
	b := New(t.TempDir())
	half := coupled("1", 60*60, "2")
	half.Cancelled = true
	b.Observe([]Train{half, coupled("2", 60*60, "1")}, 5000)

	if rows := b.Top(25, noLive, noReason, 5000); rows[0].Cancelled {
		t.Error("one portion cancelled should not cancel the whole train")
	}

	b2 := New(t.TempDir())
	other := coupled("2", 60*60, "1")
	other.Cancelled = true
	b2.Observe([]Train{half, other}, 5000)
	if rows := b2.Top(25, noLive, noReason, 5000); !rows[0].Cancelled {
		t.Error("both portions cancelled is a cancelled train")
	}
}

func TestAReasonIsTakenFromWhicheverPortionHasOne(t *testing.T) {
	b := New(t.TempDir())
	b.Observe([]Train{coupled("1", 60*60, "2"), coupled("2", 60*60, "1")}, 5000)

	only2 := func(n string) string {
		if n == "2" {
			return "panne de signalisation"
		}
		return ""
	}
	if got := b.Top(25, noLive, only2, 5000)[0].Reason; got != "panne de signalisation" {
		t.Errorf("reason %q, want the one the other portion carries", got)
	}
}

func TestThePartnershipSurvivesARestart(t *testing.T) {
	// Coupling is detected from the live feed, and by the time anyone reads the
	// day's ranking the train has usually finished. If it is not written down
	// it cannot be recovered.
	dir := t.TempDir()
	b := New(dir)
	b.Observe([]Train{coupled("1", 60*60, "2"), coupled("2", 60*60, "1")}, 5000)
	if err := b.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "daily-board.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !json.Valid(raw) {
		t.Fatal("the board is not valid JSON")
	}

	again := New(dir)
	if err := again.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if rows := again.Top(25, noLive, noReason, 5000); len(rows) != 1 {
		t.Fatalf("got %d rows after a restart, want 1", len(rows))
	}
}

func TestAPartnerWithNoEntryIsStillNamed(t *testing.T) {
	// Its own delay never reached the board's threshold, so there is nothing to
	// merge away — but it is still part of the train and belongs in the label.
	b := New(t.TempDir())
	b.Observe([]Train{coupled("1", 60*60, "2"), late("2", 60)}, 5000)

	rows := b.Top(25, noLive, noReason, 5000)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if len(rows[0].CoupledWith) != 1 || rows[0].CoupledWith[0] != "2" {
		t.Errorf("coupledWith = %v, want [2]", rows[0].CoupledWith)
	}
}
