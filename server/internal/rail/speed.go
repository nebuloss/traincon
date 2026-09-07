// Package rail routes trains over the French national network.
//
// The graph is built from SNCF Réseau's "formes-des-lignes-du-rfn" export and
// weighted with "vitesse-maximale-nominale-sur-ligne", so a train can be placed
// on the rails rather than on a straight line, with a bearing that follows real
// curves and a speed profile taken from the line's own limits.
package rail

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// FastKmh is the threshold at which a line is a LGV: high-speed, and closed to
// ordinary traffic. Routing a TER over one would put it on track it may not use.
const FastKmh = 250

// defaultSpeedKmh weights track whose line speed is unknown. Low enough that
// routing prefers a line with a known speed where one exists.
const defaultSpeedKmh = 100

// pkPattern matches SNCF's kilometre-point notation, "629+739" meaning
// 629.739 km along the line.
var pkPattern = regexp.MustCompile(`^(-?\d+)\s*\+\s*(\d+)$`)

// parsePK reads a kilometre point. The second result is false when the value is
// absent or unparseable, which is common enough in the export to be ordinary
// rather than an error.
func parsePK(v string) (float64, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	if m := pkPattern.FindStringSubmatch(v); m != nil {
		whole, err1 := strconv.ParseFloat(m[1], 64)
		metres, err2 := strconv.ParseFloat(m[2], 64)
		if err1 == nil && err2 == nil {
			// The fraction runs the same way as the whole part: "-3+500" is
			// 3.5 km before the origin, not 2.5. The TypeScript adds it
			// unconditionally, which is wrong — but no negative kilometre
			// point occurs in the export (0 of 4 694), so the two agree on
			// every value either has ever seen.
			if strings.HasPrefix(m[1], "-") {
				return whole - metres/1000, true
			}
			return whole + metres/1000, true
		}
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", "."), 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	return n, true
}

// SpeedRow is one row of the line-speed export.
type SpeedRow struct {
	CodeLigne string `json:"code_ligne"`
	VMax      string `json:"v_max"`
	PKD       string `json:"pkd"`
	PKF       string `json:"pkf"`
}

// span is a stretch of one line with a single design speed.
type span struct {
	from, to float64
	kmh      float64
}

// SpeedIndex answers what a stretch of track is designed for, by line code and
// kilometre point.
type SpeedIndex struct {
	byLine map[string][]span
	// maxOf is the fastest span on each line, the answer when a section cannot
	// be placed by kilometre point.
	maxOf map[string]float64
}

// NewSpeedIndex indexes the export. Rows without a usable line code or speed are
// dropped: a missing speed is not a zero-speed line.
func NewSpeedIndex(rows []SpeedRow) *SpeedIndex {
	idx := &SpeedIndex{byLine: make(map[string][]span), maxOf: make(map[string]float64)}
	for _, r := range rows {
		kmh, err := strconv.ParseFloat(r.VMax, 64)
		if r.CodeLigne == "" || err != nil || kmh <= 0 || math.IsInf(kmh, 0) {
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
			from: math.Min(a, b),
			to:   math.Max(a, b),
			kmh:  kmh,
		})
		if kmh > idx.maxOf[r.CodeLigne] {
			idx.maxOf[r.CodeLigne] = kmh
		}
	}
	return idx
}

// SpeedFor returns the design speed of a section of line.
//
// Where the section can be placed by kilometre point, the answer is the fastest
// span it overlaps — a section carrying both a 300 and a 160 stretch is treated
// as the fast one, because that is what decides whether it is a LGV. Where it
// cannot be placed, the line's own maximum stands in, and where the line is
// unknown, the default does.
func (s *SpeedIndex) SpeedFor(code string, pkA, pkB float64, haveA, haveB bool) float64 {
	return s.SpeedForOr(code, pkA, pkB, haveA, haveB, defaultSpeedKmh)
}

// SpeedForOr is SpeedFor with the caller's own fallback. The map passes zero:
// it draws unknown track as ordinary, and claiming 100 would be claiming
// knowledge the export does not have.
func (s *SpeedIndex) SpeedForOr(code string, pkA, pkB float64, haveA, haveB bool, fallback float64) float64 {
	if s == nil || code == "" {
		return fallback
	}
	spans := s.byLine[code]
	if len(spans) == 0 {
		return fallback
	}
	if !haveA || !haveB {
		return s.maxOf[code]
	}

	lo, hi := math.Min(pkA, pkB), math.Max(pkA, pkB)
	best, hit := 0.0, false
	for _, sp := range spans {
		if sp.to < lo || sp.from > hi {
			continue
		}
		hit = true
		if sp.kmh > best {
			best = sp.kmh
		}
	}
	if !hit {
		return s.maxOf[code]
	}
	return best
}
