package geo

import (
	"math"
	"testing"
)

var (
	parisLyon  = Point{Lat: 48.8443, Lon: 2.3743}  // Paris Gare de Lyon
	lyonPartD  = Point{Lat: 45.7605, Lon: 4.8595}  // Lyon Part-Dieu
	strasbourg = Point{Lat: 48.5850, Lon: 7.7345}  // Strasbourg
	bordeaux   = Point{Lat: 44.8262, Lon: -0.5560} // Bordeaux Saint-Jean
)

func closeTo(t *testing.T, got, want, tol float64, what string) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.4f, want %.4f (±%g)", what, got, want, tol)
	}
}

func TestHaversineKnownDistances(t *testing.T) {
	// Anchored on real distances: a unit slip in the radius or a
	// degrees/radians mix-up moves these by more than the tolerance.
	tests := []struct {
		name string
		a, b Point
		want float64
	}{
		{"Paris to Lyon", parisLyon, lyonPartD, 392},
		{"Paris to Strasbourg", parisLyon, strasbourg, 397},
		{"Paris to Bordeaux", parisLyon, bordeaux, 499},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			closeTo(t, Haversine(tc.a, tc.b), tc.want, 6, "distance km")
		})
	}
}

func TestHaversineIsSymmetricAndZeroOnItself(t *testing.T) {
	if d := Haversine(parisLyon, parisLyon); d != 0 {
		t.Errorf("distance to itself = %v, want 0", d)
	}
	there := Haversine(parisLyon, bordeaux)
	back := Haversine(bordeaux, parisLyon)
	closeTo(t, there, back, 1e-9, "symmetry")
}

func TestHaversineAtMatchesHaversine(t *testing.T) {
	// The bare-coordinate form exists for the routing loop; it must not drift
	// from the struct form.
	want := Haversine(parisLyon, strasbourg)
	got := HaversineAt(parisLyon.Lat, parisLyon.Lon, strasbourg.Lat, strasbourg.Lon)
	closeTo(t, got, want, 1e-12, "HaversineAt")
}

func TestBearing(t *testing.T) {
	tests := []struct {
		name string
		a, b Point
		want float64
	}{
		// Lyon is south and east of Paris, so south-east.
		{"Paris to Lyon is south-east", parisLyon, lyonPartD, 148},
		// Strasbourg is almost due east.
		{"Paris to Strasbourg is east", parisLyon, strasbourg, 92},
		// Bordeaux is south-west.
		{"Paris to Bordeaux is south-west", parisLyon, bordeaux, 208},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			closeTo(t, Bearing(tc.a, tc.b), tc.want, 4, "bearing deg")
		})
	}
}

func TestBearingIsAlwaysInRange(t *testing.T) {
	// The modulo has to leave a compass bearing, including due west, which is
	// where a naive atan2 conversion lands on a negative number.
	west := Bearing(parisLyon, Point{Lat: parisLyon.Lat, Lon: parisLyon.Lon - 1})
	closeTo(t, west, 270, 1, "due west")
	for _, b := range []Point{lyonPartD, strasbourg, bordeaux} {
		if got := Bearing(parisLyon, b); got < 0 || got >= 360 {
			t.Errorf("bearing %v out of [0,360)", got)
		}
	}
}

func TestGreatCirclePinsItsEnds(t *testing.T) {
	// A train at fraction 0 is at its origin and at 1 is at its destination.
	// Rounding here would leave it short of its own terminus.
	start := GreatCircle(parisLyon, lyonPartD, 0)
	closeTo(t, start.Lat, parisLyon.Lat, 1e-9, "f=0 lat")
	closeTo(t, start.Lon, parisLyon.Lon, 1e-9, "f=0 lon")

	end := GreatCircle(parisLyon, lyonPartD, 1)
	closeTo(t, end.Lat, lyonPartD.Lat, 1e-9, "f=1 lat")
	closeTo(t, end.Lon, lyonPartD.Lon, 1e-9, "f=1 lon")
}

func TestGreatCircleMidpointIsHalfway(t *testing.T) {
	mid := GreatCircle(parisLyon, lyonPartD, 0.5)
	total := Haversine(parisLyon, lyonPartD)
	closeTo(t, Haversine(parisLyon, mid), total/2, 1e-6, "first half")
	closeTo(t, Haversine(mid, lyonPartD), total/2, 1e-6, "second half")
}

func TestGreatCircleOnACoincidentPair(t *testing.T) {
	// Two calls at the same coordinates happen in the feed; the interpolation
	// must not divide by a zero-length arc.
	got := GreatCircle(parisLyon, parisLyon, 0.5)
	if got != parisLyon {
		t.Errorf("got %v, want %v", got, parisLyon)
	}
}

func BenchmarkHaversineAt(b *testing.B) {
	// Called once per graph edge per routing, so its cost is the routing's.
	for i := 0; i < b.N; i++ {
		_ = HaversineAt(parisLyon.Lat, parisLyon.Lon, lyonPartD.Lat, lyonPartD.Lon)
	}
}
