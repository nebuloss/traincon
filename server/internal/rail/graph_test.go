package rail

import (
	"math"
	"testing"
)

// A small grid to route over, laid out so the answers are obvious:
//
//	a --- b --- c      the top row is a fast line
//	|                  the left edge is a slow link down to d
//	d --- e --- f      the bottom row is slow
//
// a and f are joined only through the grid, so a route between them has to
// choose a row, which is what the speed weighting decides.
func gridGraph(t *testing.T, topKmh, bottomKmh float64) (*Graph, map[string]int32) {
	t.Helper()
	b := NewBuilder()
	id := map[string]int32{
		"a": b.NodeAt(48.00, 2.00),
		"b": b.NodeAt(48.00, 2.10),
		"c": b.NodeAt(48.00, 2.20),
		"d": b.NodeAt(47.90, 2.00),
		"e": b.NodeAt(47.90, 2.10),
		"f": b.NodeAt(47.90, 2.20),
	}
	b.Link(id["a"], id["b"], topKmh)
	b.Link(id["b"], id["c"], topKmh)
	b.Link(id["d"], id["e"], bottomKmh)
	b.Link(id["e"], id["f"], bottomKmh)
	b.Link(id["a"], id["d"], 60) // the rung joining the rows
	b.Link(id["c"], id["f"], 60)
	return b.Build(), id
}

func TestNodesAreSharedWhenTheyCoincide(t *testing.T) {
	// Two line sections meeting at a junction must become one node, or the
	// network is a pile of fragments that cannot be routed across.
	b := NewBuilder()
	first := b.NodeAt(48.5, 2.5)
	again := b.NodeAt(48.5, 2.5)
	if first != again {
		t.Errorf("same position gave ids %d and %d", first, again)
	}
	// Within the snapping distance (~11 m) is still the same node.
	near := b.NodeAt(48.50002, 2.50002)
	if near != first {
		t.Errorf("a point 2 m away became node %d, not %d", near, first)
	}
	// Well outside it is not.
	if far := b.NodeAt(48.51, 2.51); far == first {
		t.Error("a point 1 km away was welded into the same node")
	}
}

func TestBuildPlacesEveryEdgeInItsOwnRow(t *testing.T) {
	g, id := gridGraph(t, 300, 100)

	if got, want := g.NodeCount(), 6; got != want {
		t.Errorf("nodes = %d, want %d", got, want)
	}
	// Six undirected links, each stored in both directions.
	if got, want := g.EdgeCount(), 12; got != want {
		t.Errorf("directed edges = %d, want %d", got, want)
	}

	// Every node's edges must land inside its own row, and every row must be
	// contiguous — the property the whole layout depends on.
	for n := int32(0); n < int32(g.NodeCount()); n++ {
		lo, hi := g.rowStart[n], g.rowStart[n+1]
		if lo > hi {
			t.Fatalf("node %d has a reversed row [%d,%d)", n, lo, hi)
		}
		for e := lo; e < hi; e++ {
			if g.edgeTo[e] == n {
				t.Errorf("node %d has an edge to itself", n)
			}
		}
	}
	if g.rowStart[g.NodeCount()] != int32(g.EdgeCount()) {
		t.Errorf("rows cover %d edges, but there are %d", g.rowStart[g.NodeCount()], g.EdgeCount())
	}

	// b sits between a and c, so it has exactly two neighbours.
	lo, hi := g.rowStart[id["b"]], g.rowStart[id["b"]+1]
	if hi-lo != 2 {
		t.Errorf("b has %d edges, want 2", hi-lo)
	}
}

func TestRouteTakesTheFasterRowNotTheShorterOne(t *testing.T) {
	// Both rows are the same length. Minimising time is what puts a train on
	// the fast one — the reason a TGV uses the LGV rather than the classic
	// line beside it.
	g, id := gridGraph(t, 300, 100)
	path := g.Route(id["a"], id["f"], 14, true)
	if path == nil {
		t.Fatal("no route from a to f")
	}
	if !contains(path, id["b"]) || !contains(path, id["c"]) {
		t.Errorf("route %v did not use the fast top row", path)
	}
}

func TestRouteAvoidsHighSpeedLinesWhenNotAllowed(t *testing.T) {
	// A TER may not use a LGV. With the fast row excluded the only way across
	// is the slow one, even though it takes longer.
	g, id := gridGraph(t, 300, 100)
	path := g.Route(id["a"], id["f"], 14, false)
	if path == nil {
		t.Fatal("no route from a to f with fast lines excluded")
	}
	if contains(path, id["b"]) {
		t.Errorf("route %v used a high-speed line it may not", path)
	}
	if !contains(path, id["e"]) {
		t.Errorf("route %v did not use the classic row", path)
	}
}

func TestRouteEndpointsAndFailures(t *testing.T) {
	g, id := gridGraph(t, 300, 100)

	t.Run("a node routes to itself", func(t *testing.T) {
		if got := g.Route(id["a"], id["a"], 14, true); len(got) != 1 || got[0] != id["a"] {
			t.Errorf("got %v, want [%d]", got, id["a"])
		}
	})

	t.Run("the path starts and ends where asked", func(t *testing.T) {
		path := g.Route(id["a"], id["f"], 14, true)
		if path[0] != id["a"] || path[len(path)-1] != id["f"] {
			t.Errorf("path runs %d..%d, want %d..%d", path[0], path[len(path)-1], id["a"], id["f"])
		}
	})

	t.Run("an unreachable node gives nothing", func(t *testing.T) {
		b := NewBuilder()
		here := b.NodeAt(48, 2)
		there := b.NodeAt(43, 5) // no link between them
		if got := b.Build().Route(here, there, 14, true); got != nil {
			t.Errorf("got %v, want nil", got)
		}
	})

	t.Run("a time budget too small gives nothing", func(t *testing.T) {
		if got := g.Route(id["a"], id["f"], 1e-9, true); got != nil {
			t.Errorf("got %v, want nil", got)
		}
	})

	t.Run("an out-of-range node gives nothing", func(t *testing.T) {
		if got := g.Route(0, 9999, 14, true); got != nil {
			t.Errorf("got %v, want nil", got)
		}
	})
}

func TestNearest(t *testing.T) {
	g, id := gridGraph(t, 300, 100)

	t.Run("finds the node under the point", func(t *testing.T) {
		got, km, ok := g.Nearest(48.0001, 2.0001, 5)
		if !ok {
			t.Fatal("found nothing")
		}
		if got != id["a"] {
			t.Errorf("got node %d, want %d", got, id["a"])
		}
		if km > 0.05 {
			t.Errorf("distance %v km, want under 50 m", km)
		}
	})

	t.Run("respects the radius", func(t *testing.T) {
		// Well out to sea, far from any of the grid.
		if _, _, ok := g.Nearest(46.0, 0.0, 5); ok {
			t.Error("found a node 200 km away within a 5 km radius")
		}
	})

	t.Run("widens until it finds one", func(t *testing.T) {
		if _, _, ok := g.Nearest(46.0, 0.0, 400); !ok {
			t.Error("a 400 km radius should reach the grid")
		}
	})
}

func TestStitchWeldsDanglingEndsOnly(t *testing.T) {
	// Two sections that should meet but whose vertices do not coincide: the
	// export ships them as separate features, and without welding the network
	// is disconnected.
	b := NewBuilder()
	left := b.NodeAt(48.0, 2.0)
	leftEnd := b.NodeAt(48.0, 2.0100)
	rightStart := b.NodeAt(48.0, 2.0105) // ~37 m further on, a separate feature
	right := b.NodeAt(48.0, 2.0200)
	b.Link(left, leftEnd, 100)
	b.Link(rightStart, right, 100)

	if welded := b.Stitch(stitchToleranceKm); welded == 0 {
		t.Fatal("nothing was welded")
	}
	g := b.Build()
	if path := g.Route(left, right, 14, true); path == nil {
		t.Error("the two sections are still disconnected")
	}
}

func TestStitchLeavesAGenuineGapAlone(t *testing.T) {
	// Two ends a kilometre apart are not the same junction, and joining them
	// would invent track that does not exist.
	b := NewBuilder()
	a := b.NodeAt(48.0, 2.0)
	aEnd := b.NodeAt(48.0, 2.01)
	bStart := b.NodeAt(48.0, 2.05)
	bEnd := b.NodeAt(48.0, 2.06)
	b.Link(a, aEnd, 100)
	b.Link(bStart, bEnd, 100)

	if welded := b.Stitch(stitchToleranceKm); welded != 0 {
		t.Errorf("welded %d gaps that should have been left alone", welded)
	}
}

func TestParsePK(t *testing.T) {
	tests := []struct {
		in    string
		want  float64
		valid bool
	}{
		{"629+739", 629.739, true}, // the export's own notation
		{"0+000", 0, true},         // the start of a line
		{"-3+500", -3.5, true},     // a line runs negative before its origin
		{" 12+050 ", 12.05, true},  // padded
		{"42.7", 42.7, true},       // already decimal
		{"42,7", 42.7, true},       // decimal comma
		{"", 0, false},             // absent, which is ordinary in this export
		{"not a pk", 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := parsePK(tc.in)
			if ok != tc.valid {
				t.Fatalf("parsePK(%q) valid = %v, want %v", tc.in, ok, tc.valid)
			}
			if ok && math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("parsePK(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestSpeedIndex(t *testing.T) {
	idx := NewSpeedIndex([]SpeedRow{
		{CodeLigne: "420000", VMax: "320", PKD: "0+000", PKF: "100+000"},
		{CodeLigne: "420000", VMax: "160", PKD: "100+000", PKF: "200+000"},
		{CodeLigne: "830000", VMax: "140", PKD: "0+000", PKF: "50+000"},
		{CodeLigne: "", VMax: "300"},     // no line code: dropped
		{CodeLigne: "999999", VMax: "0"}, // no speed is not a zero-speed line
	})

	tests := []struct {
		name         string
		code         string
		pkA, pkB     float64
		haveA, haveB bool
		want         float64
	}{
		{"inside the fast span", "420000", 10, 20, true, true, 320},
		{"inside the slow span", "420000", 150, 160, true, true, 160},
		{"straddling both takes the faster", "420000", 50, 150, true, true, 320},
		{"beyond every span falls back to the line maximum", "420000", 900, 950, true, true, 320},
		{"without kilometre points, the line maximum", "420000", 0, 0, false, false, 320},
		{"another line", "830000", 10, 20, true, true, 140},
		{"an unknown line", "111111", 10, 20, true, true, defaultSpeedKmh},
		{"a line with no usable speed", "999999", 10, 20, true, true, defaultSpeedKmh},
		{"no line code at all", "", 10, 20, true, true, defaultSpeedKmh},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := idx.SpeedFor(tc.code, tc.pkA, tc.pkB, tc.haveA, tc.haveB)
			if got != tc.want {
				t.Errorf("SpeedFor(%q) = %v, want %v", tc.code, got, tc.want)
			}
		})
	}

	t.Run("a nil index answers the default", func(t *testing.T) {
		var none *SpeedIndex
		if got := none.SpeedFor("420000", 0, 1, true, true); got != defaultSpeedKmh {
			t.Errorf("got %v, want %v", got, defaultSpeedKmh)
		}
	})
}

func contains(path []int32, want int32) bool {
	for _, id := range path {
		if id == want {
			return true
		}
	}
	return false
}
