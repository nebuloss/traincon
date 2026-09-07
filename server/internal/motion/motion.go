// Package motion says where along a leg a train has got to at a given moment.
//
// The server evaluates this once a minute, when the feed refreshes. The map
// evaluates it twelve times a second, so the train moves — but it does not
// repeat the work: the server sends the leg's profile in the journey payload
// and the browser only interpolates it. That split is why the two can never
// disagree, and why porting the server to Go duplicates nothing: SampleProfile
// is server-only, and the client keeps its own dozen lines of interpolation.
//
// The profile is where the train has got to, as a fraction of the distance, at
// each of a series of equally spaced moments. It is not a straight line: a
// train spends its first and last kilometres accelerating and braking, so it
// covers less ground at the ends of a leg than in the middle.
package motion

// ProfileSamples is how many points describe one leg.
//
// Uniform, and simply enough of them. The curve bends wherever the train
// changes speed, and that is not only at the ends — a speed restriction puts a
// bend in the middle — so clustering samples at the ends was tried and made the
// restriction case worse than it fixed the approach case.
//
// Measured worst-case error against the exact curve, over uniform lines, short
// legs, mid-leg restrictions and repeated limit changes: about 130 m on a
// 500 km leg, and under 30 m on anything of ordinary length. That sits well
// inside the uncertainty of the position itself, which comes from a feed that
// only observes trains where they stop.
const ProfileSamples = 128

// SampleProfile builds a leg's profile from its distance and time curves.
//
// cum and cumT are cumulative distance and cumulative nominal time at each
// vertex of the routed path. The result has ProfileSamples+1 entries running
// from 0 to 1, or nil for a path too short or too degenerate to describe.
func SampleProfile(cum, cumT []float64) []float64 {
	n := len(cum)
	if n < 2 || len(cumT) != n {
		return nil
	}
	totalD, totalT := cum[n-1], cumT[n-1]
	if totalD <= 0 || totalT <= 0 {
		return nil
	}

	out := make([]float64, ProfileSamples+1)
	j := 1
	for k := 0; k <= ProfileSamples; k++ {
		t := float64(k) / ProfileSamples * totalT
		for j < n-1 && cumT[j] < t {
			j++
		}
		var within float64
		if dt := cumT[j] - cumT[j-1]; dt > 0 {
			within = (t - cumT[j-1]) / dt
		}
		out[k] = (cum[j-1] + (cum[j]-cum[j-1])*within) / totalD
	}
	// Pin the ends: rounding must not leave a train short of its own terminus.
	out[0] = 0
	out[ProfileSamples] = 1
	return out
}

// DistanceFraction returns the fraction of a leg's distance covered at a
// fraction of its duration.
//
// With no profile — a leg with no routed geometry — it falls back to a straight
// line, which is the same assumption the rest of the code makes about those.
func DistanceFraction(profile []float64, timeFraction float64) float64 {
	f := min(max(timeFraction, 0), 1)
	if len(profile) < 2 {
		return f
	}
	last := len(profile) - 1
	x := f * float64(last)
	i := min(last-1, int(x))
	a := profile[i]
	return a + (profile[i+1]-a)*(x-float64(i))
}
