// Package blocks says how closely one train may follow another.
//
// Trains are spaced by block: the line is divided into sections and a following
// train may not enter one still occupied. So a train catching up to a slower one
// does not close the gap and sit behind it — it is stopped or slowed a block
// short, and that is what a position estimate ignoring the traffic gets wrong.
// It happens routinely on a busy two-track stretch like Bordeaux–Dax.
//
// The honest limit of this: SNCF does not publish where the signals are. The
// dataset named "images des feux de circulation ferroviaire" is a
// computer-vision corpus — bounding boxes in camera frames, no coordinates — so
// individual signals, and the franchissable / non-franchissable distinction
// between them, cannot be modelled here. What is published is the mode of block
// working per line section, and that fixes the scale of the spacing, which is
// what a position estimate actually needs.
//
// The distances below are the usual design figures for each mode, not
// measurements of any particular line.
package blocks

import (
	"bufio"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// DefaultBlockM is the fallback where the mode is unknown: a typical BAL block.
const DefaultBlockM = 1800

// cellDeg is the grid cell for the geographic lookup, roughly 11 km.
const cellDeg = 0.1

// byMode is the typical block length for each working mode, in metres.
//
// Matched on a distinctive fragment of the label, lower-cased, because the
// published wording carries qualifiers ("de voie unique", "de voie banalisée")
// that do not change the spacing.
var byMode = []struct {
	needle string
	metres float64
}{
	// Cab signalling on the LGVs: short blocks, trains three minutes apart.
	{"transmission voie-machine", 1500},
	{"european train control system", 1500},
	// The common lit automatic block.
	{"block automatique lumineux", 1800},
	// Reduced-permissivity automatic block: far longer sections, on single
	// track or quieter routes.
	{"block automatique à permissivité restreinte", 8000},
	{"block automatique a permissivite restreinte", 8000},
	// Manual and telephone block: one train per section, and the sections are
	// whole inter-station distances.
	{"block manuel", 15000},
	{"cantonnement téléphonique", 20000},
	{"cantonnement telephonique", 20000},
	// Nothing to enforce; treat as unconstrained rather than pretending.
	{"sans cantonnement", 0},
}

// LengthFor returns the block length a mode label implies, and whether the
// label was one this package knows.
func LengthFor(label string) (float64, bool) {
	if label == "" {
		return 0, false
	}
	l := strings.ToLower(label)
	for _, m := range byMode {
		if strings.Contains(l, m.needle) {
			return m.metres, true
		}
	}
	return 0, false
}

var pkPattern = regexp.MustCompile(`^(\d+)\+(\d+)$`)

// parsePK reads a kilometre point, "016+953" meaning 16.953 km.
func parsePK(pk string) (float64, bool) {
	pk = strings.TrimSpace(pk)
	if pk == "" {
		return 0, false
	}
	if m := pkPattern.FindStringSubmatch(pk); m != nil {
		whole, err1 := strconv.ParseFloat(m[1], 64)
		metres, err2 := strconv.ParseFloat(m[2], 64)
		if err1 == nil && err2 == nil {
			return whole + metres/1000, true
		}
	}
	n, err := strconv.ParseFloat(pk, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	return n, true
}

// Section is one row of the published block-working table.
type Section struct {
	CodeLigne string `json:"code_ligne"`
	Libelle   string `json:"libelle"`
	PKD       string `json:"pkd"`
	PKF       string `json:"pkf"`
	// Point is the midpoint of the section, published for every row.
	Point *struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	} `json:"geo_point_2d"`
}

type span struct {
	from, to float64
	metres   float64
}

type placed struct {
	lat, lon float64
	metres   float64
}

// Index answers how long a block is, by line section or by position.
type Index struct {
	byLine map[string][]span
	// cells holds sections by grid cell, for looking spacing up from a
	// position. The line code in this dataset is the infrastructure one and a
	// train carries a commercial line label — the two do not join, so position
	// is the only key both sides actually share.
	cells map[int64][]placed
	count int
}

// New indexes the published table.
func New(rows []Section) *Index {
	idx := &Index{byLine: make(map[string][]span), cells: make(map[int64][]placed)}
	for _, r := range rows {
		metres, known := LengthFor(r.Libelle)
		if !known {
			continue
		}
		if p := r.Point; p != nil && !math.IsNaN(p.Lat) && !math.IsNaN(p.Lon) {
			k := cellKey(p.Lat, p.Lon)
			idx.cells[k] = append(idx.cells[k], placed{lat: p.Lat, lon: p.Lon, metres: metres})
			idx.count++
		}
		if r.CodeLigne == "" {
			continue
		}
		a, okA := parsePK(r.PKD)
		b, okB := parsePK(r.PKF)
		if !okA {
			a = math.Inf(-1)
		}
		if !okB {
			b = math.Inf(1)
		}
		idx.byLine[r.CodeLigne] = append(idx.byLine[r.CodeLigne], span{
			from: math.Min(a, b), to: math.Max(a, b), metres: metres,
		})
	}
	return idx
}

// Lines reports how many line codes are indexed.
func (i *Index) Lines() int { return len(i.byLine) }

// Sections reports how many placed sections are indexed.
func (i *Index) Sections() int { return i.count }

func cellKey(lat, lon float64) int64 {
	return int64(int32(math.Floor(lat/cellDeg)))<<32 | int64(uint32(int32(math.Floor(lon/cellDeg))))
}

// SpacingFor is the minimum spacing on a section, in metres.
//
// The longest block overlapping the span, because that is the binding
// constraint: a train must clear the whole section it is in.
func (i *Index) SpacingFor(code string, pkA, pkB float64, haveA, haveB bool) float64 {
	if i == nil || code == "" {
		return DefaultBlockM
	}
	spans := i.byLine[code]
	if len(spans) == 0 {
		return DefaultBlockM
	}
	if !haveA || !haveB {
		worst := 0.0
		for _, s := range spans {
			worst = math.Max(worst, s.metres)
		}
		return worst
	}

	lo, hi := math.Min(pkA, pkB), math.Max(pkA, pkB)
	worst, hit := 0.0, false
	for _, s := range spans {
		if s.to < lo || s.from > hi {
			continue
		}
		hit = true
		worst = math.Max(worst, s.metres)
	}
	if !hit {
		return DefaultBlockM
	}
	return worst
}

// SpacingNear is the spacing near a point, in metres.
//
// It searches outward by cell ring until something is found, so a train over a
// section whose midpoint sits in a neighbouring cell still gets an answer, and
// falls back to a typical lit block where nothing is near.
func (i *Index) SpacingNear(lat, lon float64) float64 {
	if i == nil {
		return DefaultBlockM
	}
	ci := int32(math.Floor(lat / cellDeg))
	cj := int32(math.Floor(lon / cellDeg))

	for r := int32(0); r <= 3; r++ {
		best, bestD, found := 0.0, math.Inf(1), false
		for x := ci - r; x <= ci+r; x++ {
			for y := cj - r; y <= cj+r; y++ {
				// Only the new ring each time round.
				if r > 0 && abs32(x-ci) != r && abs32(y-cj) != r {
					continue
				}
				key := int64(x)<<32 | int64(uint32(y))
				for _, s := range i.cells[key] {
					d := (s.lat-lat)*(s.lat-lat) + (s.lon-lon)*(s.lon-lon)
					if d < bestD {
						bestD, best, found = d, s.metres, true
					}
				}
			}
		}
		if found {
			return best
		}
	}
	return DefaultBlockM
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// Load reads the block-working table from dataDir/geo.
//
// A missing file is not an error: spacing is a refinement, not a requirement,
// and the caller gets a nil Index whose methods answer the defaults.
func Load(dataDir string) (*Index, error) {
	path := filepath.Join(dataDir, "geo", "cantonnement.json")
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec := json.NewDecoder(bufio.NewReaderSize(f, 1<<20))
	if _, err := dec.Token(); err != nil { // opening [
		return nil, err
	}
	var rows []Section
	for dec.More() {
		var r Section
		if err := dec.Decode(&r); err != nil {
			return nil, err
		}
		rows = append(rows, r)
	}
	return New(rows), nil
}
