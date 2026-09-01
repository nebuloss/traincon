package rail

import (
	"math"
	"testing"
)

// A straight 100 km line at a constant limit, as a controlled input to the
// speed profile: every departure from a flat 200 km/h is then the physics.
func straightLine(km, limitKmh float64, segments int) (cum, segV []float64) {
	cum = make([]float64, segments+1)
	segV = make([]float64, segments)
	for i := 1; i <= segments; i++ {
		cum[i] = km * float64(i) / float64(segments)
	}
	for i := range segV {
		segV[i] = limitKmh
	}
	return cum, segV
}

func TestSpeedProfileLeavesAndArrivesAtRest(t *testing.T) {
	// A train starts stopped and ends stopped. Both fall out of the two
	// passes rather than being applied as a separate taper.
	v, cumT := speedAndTime(straightLine(100, 200, 200))
	if v[0] != 0 {
		t.Errorf("leaves at %v km/h, want 0", v[0])
	}
	if v[len(v)-1] != 0 {
		t.Errorf("arrives at %v km/h, want 0", v[len(v)-1])
	}
	if cumT[0] != 0 {
		t.Errorf("starts at t=%v, want 0", cumT[0])
	}
	for i := 1; i < len(cumT); i++ {
		if cumT[i] < cumT[i-1] {
			t.Fatalf("time went backwards at %d", i)
		}
	}
}

func TestSpeedProfileReachesTheLineSpeedInTheMiddle(t *testing.T) {
	// 100 km is far more than the ~1.5 km needed to reach 200, so the middle
	// of the leg should be sitting on the limit.
	v, _ := speedAndTime(straightLine(100, 200, 200))
	mid := v[len(v)/2]
	if math.Abs(mid-200) > 1 {
		t.Errorf("mid-leg speed %v km/h, want 200", mid)
	}
}

func TestSpeedProfileNeverExceedsTheLineSpeed(t *testing.T) {
	v, _ := speedAndTime(straightLine(100, 160, 200))
	for i, got := range v {
		if got > 160+1e-6 {
			t.Fatalf("vertex %d at %v km/h on a 160 line", i, got)
		}
	}
}

func TestSpeedProfileBrakesBeforeARestriction(t *testing.T) {
	// The reason the backward pass exists. A 300 km/h line dropping to 60 for
	// its last stretch: the train must already be slowing well before the
	// restriction, not lose 240 km/h at the boundary.
	const segments = 400
	cum, segV := straightLine(100, 300, segments)
	restrictFrom := segments * 3 / 4
	for i := restrictFrom; i < segments; i++ {
		segV[i] = 60
	}
	v, _ := speedAndTime(cum, segV)

	if v[restrictFrom] > 60+1 {
		t.Errorf("entered the restriction at %v km/h, want no more than 60", v[restrictFrom])
	}
	// A kilometre before it, the train must already be off the line speed.
	oneKmBefore := restrictFrom - segments/100
	if v[oneKmBefore] > 290 {
		t.Logf("1 km before the restriction: %v km/h", v[oneKmBefore])
	}
	if v[oneKmBefore] >= 300 {
		t.Errorf("still at line speed 1 km before a 60 restriction (%v km/h)", v[oneKmBefore])
	}
}

func TestSpeedProfileDegenerateInputs(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		v, cumT := speedAndTime(nil, nil)
		if v != nil || cumT != nil {
			t.Errorf("got %v/%v, want nil/nil", v, cumT)
		}
	})
	t.Run("one vertex", func(t *testing.T) {
		v, cumT := speedAndTime([]float64{0}, nil)
		if len(v) != 1 || v[0] != 0 || len(cumT) != 1 {
			t.Errorf("got %v/%v, want [0]/[0]", v, cumT)
		}
	})
	t.Run("a zero-length path does not take forever to cross", func(t *testing.T) {
		// Both ends at rest over no distance: the mean speed is floored so the
		// crossing time cannot be infinite.
		_, cumT := speedAndTime([]float64{0, 0}, []float64{100})
		if math.IsInf(cumT[1], 0) || math.IsNaN(cumT[1]) {
			t.Errorf("crossing time = %v", cumT[1])
		}
	})
}

func TestCacheEvictsTheColdestFirst(t *testing.T) {
	c := NewCache()
	// Each path is one vertex over the budget's worth, so two fit and the
	// third forces an eviction.
	big := func(points int) *Path {
		return &Path{Pts: make([][2]float64, points)}
	}
	c.put("a", big(pathCacheMaxPoints/2))
	c.put("b", big(pathCacheMaxPoints/2))
	if _, ok := c.get("a"); !ok {
		t.Fatal("a was evicted too early")
	}
	// Touching "a" makes "b" the coldest, so "b" goes when the budget is passed.
	c.put("c", big(pathCacheMaxPoints/2))
	if _, ok := c.get("b"); ok {
		t.Error("b survived, but it was the coldest")
	}
	if _, ok := c.get("a"); !ok {
		t.Error("a was evicted, but it had just been used")
	}
}

func TestCacheCountsVerticesNotEntries(t *testing.T) {
	c := NewCache()
	c.put("one", &Path{Pts: make([][2]float64, 1000)})
	paths, points := c.Stats()
	if paths != 1 || points != 1000 {
		t.Errorf("stats = %d paths/%d points, want 1/1000", paths, points)
	}
	c.put("two", &Path{Pts: make([][2]float64, 500)})
	if _, points = c.Stats(); points != 1500 {
		t.Errorf("points = %d, want 1500", points)
	}
}

func TestCacheRemembersThatThereIsNoRoute(t *testing.T) {
	// A leg that cannot be routed is worth remembering: otherwise every refresh
	// pays to discover it again.
	c := NewCache()
	c.put("nowhere", nil)
	p, ok := c.get("nowhere")
	if !ok {
		t.Fatal("the absence was not cached")
	}
	if p != nil {
		t.Errorf("got %v, want nil", p)
	}
	if _, points := c.Stats(); points != 0 {
		t.Errorf("a cached absence cost %d vertices", points)
	}
}

func TestPathAnchorsItsEndsOnTheGivenCoordinates(t *testing.T) {
	g, _ := gridGraph(t, 300, 100)
	// Slightly off the nodes, as a station's true coordinates are.
	const aLat, aLon = 48.0005, 2.0005
	const bLat, bLon = 48.0005, 2.2005
	p := g.Path(nil, aLat, aLon, bLat, bLon, true)
	if p == nil {
		t.Fatal("no path")
	}
	if p.Pts[0][0] != aLat || p.Pts[0][1] != aLon {
		t.Errorf("starts at %v, want the given coordinates", p.Pts[0])
	}
	last := p.Pts[len(p.Pts)-1]
	if last[0] != bLat || last[1] != bLon {
		t.Errorf("ends at %v, want the given coordinates", last)
	}
	if len(p.SegV) != len(p.Pts)-1 {
		t.Errorf("%d segments for %d vertices", len(p.SegV), len(p.Pts))
	}
	if p.Cum[0] != 0 || p.Total <= 0 {
		t.Errorf("distances start at %v and total %v", p.Cum[0], p.Total)
	}
}

func TestPathRejectsAnAbsurdDetour(t *testing.T) {
	// Two points a few hundred metres apart, joined only by a long way round,
	// should come back as no route rather than as a drawn detour.
	b := NewBuilder()
	left := b.NodeAt(48.0, 2.0)
	right := b.NodeAt(48.0, 2.005) // ~370 m apart directly
	var prev = left
	for i := 1; i <= 40; i++ { // a 40 km loop joining them
		n := b.NodeAt(48.0+float64(i)*0.01, 2.0)
		b.Link(prev, n, 100)
		prev = n
	}
	b.Link(prev, right, 100)
	g := b.Build()

	if p := g.Path(nil, 48.0, 2.0, 48.0, 2.005, true); p != nil {
		t.Errorf("accepted a %.1f km detour between points %.1f km apart", p.Total, p.Direct)
	}
}
