package store

import "math"

// A routed journey is assembled leg by leg, and consecutive legs are routed
// independently. Where two of them approach the same junction from opposite
// sides, the joined line can double back on itself for a few tens of metres —
// and a train advancing steadily along it then physically moves backwards and
// then forwards again as it crosses one. Which is exactly what it looks like.
//
// So a vertex is dropped when the path turns almost back on itself there and the
// spur is short. Real track has tight curves, but not a reversal inside 250 m;
// that is a routing artefact, not a railway.
const (
	// reversalDeg is how sharp a turn has to be to count as doubling back.
	reversalDeg = 160
	// spurM is the longest spur that may be removed. Beyond it, the shape is
	// the route's own.
	spurM = 250
	// metresPerDegLat is a local flat-earth approximation. Distances here are
	// tens of metres, so the curvature of the planet is irrelevant, and this
	// avoids a trigonometric call per vertex on a five-thousand-point line.
	metresPerDegLat = 111_320
)

var reversalCos = math.Cos(reversalDeg * math.Pi / 180)

// despike removes vertices where the route doubles back over a short spur.
func despike(coords [][2]float64) [][2]float64 {
	if len(coords) < 3 {
		return coords
	}
	out := make([][2]float64, 0, len(coords))
	out = append(out, coords[0])

	for i := 1; i < len(coords)-1; i++ {
		prev, here, next := out[len(out)-1], coords[i], coords[i+1]
		metresPerDegLon := metresPerDegLat * math.Cos(here[1]*math.Pi/180)

		ax := (here[0] - prev[0]) * metresPerDegLon
		ay := (here[1] - prev[1]) * metresPerDegLat
		bx := (next[0] - here[0]) * metresPerDegLon
		by := (next[1] - here[1]) * metresPerDegLat

		la, lb := math.Hypot(ax, ay), math.Hypot(bx, by)
		if la == 0 {
			continue // duplicate vertex, nothing to draw
		}
		if lb == 0 || math.Min(la, lb) > spurM {
			out = append(out, here)
			continue
		}
		// The cosine of the turn: -1 is a full reversal, +1 is straight on.
		if cos := (ax*bx + ay*by) / (la * lb); cos > reversalCos {
			out = append(out, here)
		}
	}
	return append(out, coords[len(coords)-1])
}

// smoothRoute de-spikes until it settles.
//
// Removing a vertex makes its neighbours adjacent, which can expose a reversal
// that was hidden behind it. On a real TGV journey one pass took 14 reversals
// down to 6 and three passes to 3; the rest are joins where a leg with no routed
// geometry meets real track at an angle, which is the route's actual shape
// rather than an artefact.
func smoothRoute(coords [][2]float64) [][2]float64 {
	out := coords
	for range 4 {
		next := despike(out)
		if len(next) == len(out) {
			break
		}
		out = next
	}
	return out
}
