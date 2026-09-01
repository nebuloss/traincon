package motion

import (
	"math"
	"testing"
)

// A leg whose distance and time curves describe constant speed, so any bend in
// the profile is the code's and not the input's.
func uniform(n int, km, hours float64) (cum, cumT []float64) {
	cum = make([]float64, n)
	cumT = make([]float64, n)
	for i := range n {
		f := float64(i) / float64(n-1)
		cum[i] = km * f
		cumT[i] = hours * f
	}
	return cum, cumT
}

func TestSampleProfileSpansZeroToOne(t *testing.T) {
	// A train must not finish short of its own terminus, which is what pinning
	// the ends is for.
	p := SampleProfile(uniform(50, 100, 1))
	if len(p) != ProfileSamples+1 {
		t.Fatalf("got %d samples, want %d", len(p), ProfileSamples+1)
	}
	if p[0] != 0 {
		t.Errorf("starts at %v, want 0", p[0])
	}
	if p[len(p)-1] != 1 {
		t.Errorf("ends at %v, want 1", p[len(p)-1])
	}
}

func TestSampleProfileNeverGoesBackwards(t *testing.T) {
	p := SampleProfile(uniform(50, 100, 1))
	for i := 1; i < len(p); i++ {
		if p[i] < p[i-1] {
			t.Fatalf("sample %d (%v) is behind %d (%v)", i, p[i], i-1, p[i-1])
		}
	}
}

func TestSampleProfileOfConstantSpeedIsAStraightLine(t *testing.T) {
	p := SampleProfile(uniform(200, 100, 1))
	for k, got := range p {
		want := float64(k) / ProfileSamples
		if math.Abs(got-want) > 1e-9 {
			t.Fatalf("sample %d = %v, want %v", k, got, want)
		}
	}
}

func TestSampleProfileRejectsWhatItCannotDescribe(t *testing.T) {
	tests := []struct {
		name       string
		cum, cumT  []float64
	}{
		{"empty", nil, nil},
		{"one vertex", []float64{0}, []float64{0}},
		{"mismatched lengths", []float64{0, 1}, []float64{0}},
		{"no distance", []float64{0, 0}, []float64{0, 1}},
		{"no time", []float64{0, 1}, []float64{0, 0}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := SampleProfile(tc.cum, tc.cumT); got != nil {
				t.Errorf("got %v, want nil", got)
			}
		})
	}
}

func TestDistanceFractionInterpolates(t *testing.T) {
	// Half the distance covered in the first tenth of the time: a profile with
	// a real bend in it, so interpolation is doing something.
	profile := []float64{0, 0.5, 1}
	tests := []struct {
		f    float64
		want float64
	}{
		{0, 0},
		{0.25, 0.25}, // a quarter of the way into the first half
		{0.5, 0.5},
		{0.75, 0.75},
		{1, 1},
	}
	for _, tc := range tests {
		if got := DistanceFraction(profile, tc.f); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("DistanceFraction(%v) = %v, want %v", tc.f, got, tc.want)
		}
	}
}

func TestDistanceFractionClampsOutsideTheLeg(t *testing.T) {
	// A train whose leg has run over its scheduled time must sit at the end of
	// it, not past it.
	profile := SampleProfile(uniform(50, 100, 1))
	if got := DistanceFraction(profile, -5); got != 0 {
		t.Errorf("before the leg: %v, want 0", got)
	}
	if got := DistanceFraction(profile, 5); got != 1 {
		t.Errorf("after the leg: %v, want 1", got)
	}
}

func TestDistanceFractionFallsBackToAStraightLine(t *testing.T) {
	// A leg with no routed geometry has no profile, and constant speed is the
	// same assumption the rest of the code makes about those.
	for _, f := range []float64{0, 0.25, 0.5, 1} {
		if got := DistanceFraction(nil, f); got != f {
			t.Errorf("DistanceFraction(nil, %v) = %v, want %v", f, got, f)
		}
	}
	if got := DistanceFraction([]float64{0.4}, 0.7); got != 0.7 {
		t.Errorf("a one-sample profile gave %v, want 0.7", got)
	}
}

func TestRoundTripAgainstTheProfileItCameFrom(t *testing.T) {
	// Sampling then interpolating should return the distance curve it was built
	// from, to within the sampling error the constant documents.
	const km, hours = 500, 2.5
	cum, cumT := uniform(400, km, hours)
	p := SampleProfile(cum, cumT)
	for i := range cum {
		f := cumT[i] / hours
		got := DistanceFraction(p, f) * km
		if math.Abs(got-cum[i]) > 0.2 { // 200 m on a 500 km leg
			t.Fatalf("at t=%.3f: %.3f km, want %.3f km", f, got, cum[i])
		}
	}
}
