package gtfs

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// zipOf builds an in-memory archive, so the reader is exercised through the
// same path Load uses rather than a stand-in.
func zipOf(t *testing.T, files map[string]string) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return zr
}

// rows collects what eachRow yields, copying because the slice is reused.
func rows(t *testing.T, body string, want []string) [][]string {
	t.Helper()
	zr := zipOf(t, map[string]string{"f.txt": body})
	var got [][]string
	if err := eachRow(zr, "f.txt", want, func(v []string) {
		got = append(got, append([]string(nil), v...))
	}); err != nil {
		t.Fatalf("eachRow: %v", err)
	}
	return got
}

func TestEachRowReturnsColumnsInTheOrderAsked(t *testing.T) {
	got := rows(t, "stop_lat,stop_id,stop_name\n48.8,X,Gare\n", []string{"stop_id", "stop_name", "stop_lat"})
	want := [][]string{{"X", "Gare", "48.8"}}
	if len(got) != 1 || got[0][0] != want[0][0] || got[0][1] != want[0][1] || got[0][2] != want[0][2] {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestEachRowQuoting(t *testing.T) {
	// SNCF station names contain commas, which is the whole reason the columns
	// cannot be split on a delimiter alone.
	tests := []struct {
		name string
		body string
		want string
	}{
		{"delimiter inside quotes", "a,b\n\"Paris, Gare de Lyon\",2\n", "Paris, Gare de Lyon"},
		{"doubled quote is one quote", "a,b\n\"say \"\"hi\"\"\",2\n", `say "hi"`},
		{"newline inside quotes", "a,b\n\"two\nlines\",2\n", "two\nlines"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := rows(t, tc.body, []string{"a"})
			if len(got) != 1 || got[0][0] != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEachRowCRLFDoesNotLeakIntoTheLastColumn(t *testing.T) {
	got := rows(t, "a,b\r\n1,2\r\n", []string{"b"})
	if len(got) != 1 || got[0][0] != "2" {
		t.Errorf("got %q, want [[2]]", got)
	}
}

func TestEachRowSkipsRaggedRowsRatherThanMisaligning(t *testing.T) {
	// Taking a short row would shift every column after it.
	got := rows(t, "a,b,c\n1,2,3\nbroken,row\n4,5,6\n", []string{"a", "c"})
	if len(got) != 2 || got[0][1] != "3" || got[1][1] != "6" {
		t.Errorf("got %v, want [[1 3] [4 6]]", got)
	}
}

func TestEachRowMissingColumnReadsEmpty(t *testing.T) {
	// A schema change should cost a field, not the process.
	got := rows(t, "a,b\n1,2\n", []string{"a", "nope"})
	if len(got) != 1 || got[0][0] != "1" || got[0][1] != "" {
		t.Errorf("got %v, want [[1 ]]", got)
	}
}

func TestEachRowHeaderIsNotData(t *testing.T) {
	if got := rows(t, "a,b\n1,2\n", []string{"a"}); len(got) != 1 {
		t.Errorf("got %d rows, want 1", len(got))
	}
	if got := rows(t, "a,b\n", []string{"a"}); len(got) != 0 {
		t.Errorf("header-only file yielded %d rows, want 0", len(got))
	}
}

func TestEachRowReadsAFinalRowWithoutTrailingNewline(t *testing.T) {
	got := rows(t, "a,b\n1,2", []string{"a", "b"})
	if len(got) != 1 || got[0][0] != "1" || got[0][1] != "2" {
		t.Errorf("got %v, want [[1 2]]", got)
	}
}

func TestEachRowTrimsHeaderNames(t *testing.T) {
	got := rows(t, "a , b\n1,2\n", []string{"a", "b"})
	if len(got) != 1 || got[0][0] != "1" || got[0][1] != "2" {
		t.Errorf("got %v, want [[1 2]]", got)
	}
}

func TestServiceMarkers(t *testing.T) {
	tests := []struct {
		code       string
		wantLabel  string
		wantFamily Family
	}{
		{"OUI", "TGV inOUI", FamilyTGV},
		{"OGO", "OUIGO", FamilyTGV},
		{"TER", "TER", FamilyTER},
		{"ICN", "Intercités de Nuit", FamilyIC},
		{"NAV", "Navette", FamilyOther},
		// An unknown marker keeps its own code, so a new service appearing in
		// the feed is visible rather than silently relabelled.
		{"ZZZ", "ZZZ", FamilyOther},
		{"", "Train", FamilyOther},
	}
	for _, tc := range tests {
		t.Run(tc.code, func(t *testing.T) {
			got := Service(tc.code)
			if got.Label != tc.wantLabel || got.Family != tc.wantFamily {
				t.Errorf("Service(%q) = %+v, want {%s %s}", tc.code, got, tc.wantLabel, tc.wantFamily)
			}
		})
	}
}

// TestLoadMatchesTheTypeScriptTables checks the port against the tables the
// TypeScript server builds from the same archive. The counts are what the
// fingerprint comparison recorded: 8 791 stops, 3 476 stations, 13 698 trains.
//
// Skipped unless the archive is present, so it does not turn CI red on a
// machine without the data.
func TestLoadMatchesTheTypeScriptTables(t *testing.T) {
	dir := os.Getenv("TRAINCON_DATA")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "data")
	}
	if _, err := os.Stat(filepath.Join(dir, "gtfs.zip")); err != nil {
		t.Skipf("no archive at %s", dir)
	}

	s, err := Load(context.Background(), dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	checks := []struct {
		what string
		got  int
		want int
	}{
		{"stops", len(s.Stops), 8791},
		{"stations", len(s.Stations), 3476},
		{"trains", len(s.Trains), 13698},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d", c.what, c.got, c.want)
		}
	}

	if s.Stale() {
		t.Error("freshly loaded tables report themselves stale")
	}
}
