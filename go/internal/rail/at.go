package rail

import "traincon/internal/geo"

// PathPoint is a place along a routed path, with what the model says is
// happening there.
type PathPoint struct {
	geo.Point
	// Bearing is the tangent of the segment, degrees clockwise from north.
	Bearing float64
	// DistKm is how far along the path this is.
	DistKm float64
	// SegIndex is the segment the point falls in.
	SegIndex int
	// ModelKmh is the modelled speed here, or false when the path carries no
	// speed profile.
	ModelKmh    float64
	HasModelKmh bool
	// LimitKmh is what the line itself permits — a property of the track, not
	// of the train on it.
	LimitKmh    float64
	HasLimitKmh bool
	// NominalHours is how long the profile says the whole path takes.
	NominalHours float64
}

// At returns the point a fraction of the way along the path, by elapsed time
// rather than by distance.
//
// Time, because a train does not cover equal ground in equal minutes: it is
// still accelerating out of one station and already braking into the next. The
// distance curve is consulted through the time curve so the point lands where
// the model actually puts it.
func (p *Path) At(f float64) PathPoint {
	frac := min(max(f, 0), 1)

	var target float64
	if len(p.CumT) == len(p.Cum) && len(p.CumT) > 0 {
		total := p.CumT[len(p.CumT)-1]
		want := frac * total
		j := 1
		for j < len(p.CumT)-1 && p.CumT[j] < want {
			j++
		}
		var within float64
		if dt := p.CumT[j] - p.CumT[j-1]; dt > 0 {
			within = (want - p.CumT[j-1]) / dt
		}
		target = p.Cum[j-1] + (p.Cum[j]-p.Cum[j-1])*within
	} else {
		target = frac * p.Total
	}

	i := 1
	for i < len(p.Cum)-1 && p.Cum[i] < target {
		i++
	}
	var t float64
	if segLen := p.Cum[i] - p.Cum[i-1]; segLen > 0 {
		t = (target - p.Cum[i-1]) / segLen
	}

	a := geo.Point{Lat: p.Pts[i-1][0], Lon: p.Pts[i-1][1]}
	b := geo.Point{Lat: p.Pts[i][0], Lon: p.Pts[i][1]}

	pt := PathPoint{
		Point:    geo.Point{Lat: a.Lat + (b.Lat-a.Lat)*t, Lon: a.Lon + (b.Lon-a.Lon)*t},
		Bearing:  geo.Bearing(a, b),
		DistKm:   target,
		SegIndex: i,
	}
	// The modelled speed here, interpolated across the segment, so what is
	// reported is exactly what produced the timing.
	if len(p.V) > i {
		pt.ModelKmh = p.V[i-1] + (p.V[i]-p.V[i-1])*t
		pt.HasModelKmh = true
	}
	if len(p.SegV) > i-1 {
		pt.LimitKmh = p.SegV[i-1]
		pt.HasLimitKmh = true
	}
	if len(p.CumT) > 0 {
		pt.NominalHours = p.CumT[len(p.CumT)-1]
	}
	return pt
}
