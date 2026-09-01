package blocks

import "testing"

func point(lat, lon float64) *struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
} {
	return &struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	}{Lat: lat, Lon: lon}
}

func TestLengthForKnownModes(t *testing.T) {
	tests := []struct {
		label string
		want  float64
	}{
		// The published wording carries qualifiers that do not change the
		// spacing, so the match is on a fragment.
		{"Block Automatique Lumineux", 1800},
		{"block automatique lumineux de voie banalisée", 1800},
		{"Transmission Voie-Machine", 1500},
		{"European Train Control System niveau 2", 1500},
		{"Block automatique à permissivité restreinte", 8000},
		{"block automatique a permissivite restreinte", 8000},
		{"Block manuel de voie unique", 15000},
		{"Cantonnement téléphonique", 20000},
		// Nothing to enforce, which is different from not knowing.
		{"Sans cantonnement", 0},
	}
	for _, tc := range tests {
		t.Run(tc.label, func(t *testing.T) {
			got, known := LengthFor(tc.label)
			if !known {
				t.Fatalf("LengthFor(%q) was not recognised", tc.label)
			}
			if got != tc.want {
				t.Errorf("got %v m, want %v", got, tc.want)
			}
		})
	}
}

func TestLengthForDistinguishesUnknownFromUnconstrained(t *testing.T) {
	// "Sans cantonnement" means zero spacing; an unrecognised label means we
	// do not know, and the caller must fall back rather than enforce nothing.
	if m, known := LengthFor("sans cantonnement"); !known || m != 0 {
		t.Errorf("sans cantonnement = (%v,%v), want (0,true)", m, known)
	}
	if _, known := LengthFor("quelque chose d'autre"); known {
		t.Error("an unknown mode was reported as recognised")
	}
	if _, known := LengthFor(""); known {
		t.Error("an empty label was reported as recognised")
	}
}

func TestParsePK(t *testing.T) {
	tests := []struct {
		in    string
		want  float64
		valid bool
	}{
		{"016+953", 16.953, true},
		{"0+000", 0, true},
		{" 12+050 ", 12.05, true},
		{"42.7", 42.7, true},
		{"", 0, false},
		{"nonsense", 0, false},
	}
	for _, tc := range tests {
		got, ok := parsePK(tc.in)
		if ok != tc.valid || (ok && got != tc.want) {
			t.Errorf("parsePK(%q) = (%v,%v), want (%v,%v)", tc.in, got, ok, tc.want, tc.valid)
		}
	}
}

func TestSpacingForTakesTheLongestOverlappingBlock(t *testing.T) {
	// The binding constraint: a train must clear the whole section it is in.
	idx := New([]Section{
		{CodeLigne: "1", Libelle: "Block automatique lumineux", PKD: "0+000", PKF: "50+000"},
		{CodeLigne: "1", Libelle: "Block manuel", PKD: "50+000", PKF: "100+000"},
	})
	tests := []struct {
		name     string
		pkA, pkB float64
		want     float64
	}{
		{"inside the lit block", 10, 20, 1800},
		{"inside the manual block", 60, 70, 15000},
		{"straddling both takes the longer", 40, 60, 15000},
		{"beyond every section falls back", 500, 600, DefaultBlockM},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := idx.SpacingFor("1", tc.pkA, tc.pkB, true, true); got != tc.want {
				t.Errorf("got %v m, want %v", got, tc.want)
			}
		})
	}
}

func TestSpacingForUnknownLine(t *testing.T) {
	idx := New([]Section{{CodeLigne: "1", Libelle: "Block automatique lumineux"}})
	if got := idx.SpacingFor("999", 0, 1, true, true); got != DefaultBlockM {
		t.Errorf("got %v m, want the default %v", got, DefaultBlockM)
	}
	if got := idx.SpacingFor("", 0, 1, true, true); got != DefaultBlockM {
		t.Errorf("got %v m for no line code, want the default", got)
	}
}

func TestSpacingNearFindsTheClosestSection(t *testing.T) {
	// The line code in this dataset is the infrastructure one and a train
	// carries a commercial label, so position is the only shared key.
	idx := New([]Section{
		{Libelle: "Block automatique lumineux", Point: point(48.0, 2.0)},
		{Libelle: "Transmission voie-machine", Point: point(43.0, 5.0)},
	})
	if got := idx.SpacingNear(48.001, 2.001); got != 1800 {
		t.Errorf("near the lit block: %v m, want 1800", got)
	}
	if got := idx.SpacingNear(43.001, 5.001); got != 1500 {
		t.Errorf("near the LGV: %v m, want 1500", got)
	}
}

func TestSpacingNearWidensToTheNeighbouringCell(t *testing.T) {
	// A train over a section whose midpoint sits in the next cell still needs
	// an answer.
	idx := New([]Section{{Libelle: "Block manuel", Point: point(48.05, 2.05)}})
	if got := idx.SpacingNear(48.15, 2.15); got != 15000 {
		t.Errorf("got %v m, want 15000 from the neighbouring cell", got)
	}
}

func TestSpacingNearFallsBackWhereNothingIsClose(t *testing.T) {
	idx := New([]Section{{Libelle: "Block manuel", Point: point(48.0, 2.0)}})
	if got := idx.SpacingNear(10, 10); got != DefaultBlockM {
		t.Errorf("got %v m far from anything, want the default %v", got, DefaultBlockM)
	}
}

func TestANilIndexAnswersTheDefaults(t *testing.T) {
	// The data file is optional: spacing is a refinement, not a requirement,
	// and a nil index must behave rather than panic.
	var idx *Index
	if got := idx.SpacingNear(48, 2); got != DefaultBlockM {
		t.Errorf("SpacingNear on nil = %v, want %v", got, DefaultBlockM)
	}
	if got := idx.SpacingFor("1", 0, 1, true, true); got != DefaultBlockM {
		t.Errorf("SpacingFor on nil = %v, want %v", got, DefaultBlockM)
	}
}

func TestUnrecognisedModesAreNotIndexed(t *testing.T) {
	idx := New([]Section{
		{CodeLigne: "1", Libelle: "quelque chose d'autre", Point: point(48, 2)},
		{CodeLigne: "2", Libelle: "Block manuel", Point: point(48, 2)},
	})
	if idx.Lines() != 1 {
		t.Errorf("indexed %d lines, want 1 — the unknown mode should be dropped", idx.Lines())
	}
	if idx.Sections() != 1 {
		t.Errorf("indexed %d sections, want 1", idx.Sections())
	}
}

func TestLoadTreatsAMissingFileAsAbsentNotBroken(t *testing.T) {
	idx, err := Load(t.TempDir())
	if err != nil {
		t.Errorf("a missing file gave an error: %v", err)
	}
	if idx != nil {
		t.Error("a missing file produced an index")
	}
	// And the nil it returns still answers.
	if got := idx.SpacingNear(48, 2); got != DefaultBlockM {
		t.Errorf("got %v, want %v", got, DefaultBlockM)
	}
}
