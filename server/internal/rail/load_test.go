package rail

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// dataDir returns where the SNCF exports live, or skips: a machine without them
// should not fail the suite.
func dataDir(t testing.TB) string {
	t.Helper()
	dir := os.Getenv("TRAINCON_DATA")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "data")
	}
	if _, err := os.Stat(filepath.Join(dir, "geo", "rfn.geojson")); err != nil {
		t.Skipf("no network export at %s", dir)
	}
	return dir
}

// TestLoadMatchesTheTypeScriptGraph pins the port against the graph the
// TypeScript server builds from the same two exports.
//
// The counts are what that server reports: 181 290 nodes and 363 946 directed
// edges. They are the strongest equivalence check available short of comparing
// routes, because every stage — the in-service filter, vertex snapping, line
// speeds and the stitching pass — has to agree for both to come out right.
func TestLoadMatchesTheTypeScriptGraph(t *testing.T) {
	g, err := Load(dataDir(t))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got, want := g.NodeCount(), 181290; got != want {
		t.Errorf("nodes = %d, want %d", got, want)
	}
	if got, want := g.EdgeCount(), 363946; got != want {
		t.Errorf("directed edges = %d, want %d", got, want)
	}
	if g.rowStart[g.NodeCount()] != int32(g.EdgeCount()) {
		t.Errorf("row index covers %d edges, but there are %d",
			g.rowStart[g.NodeCount()], g.EdgeCount())
	}
}

// TestGraphMemory reports what the finished graph occupies.
//
// This is the number the whole layout is for. The TypeScript graph holds the
// same network in 66 MB — 365 bytes per node — because its adjacency is a slice
// per node and V8 charges an object header for each. The flat arrays here come
// to lat+lon (16 B/node), the row index (4 B/node) and, per directed edge, a
// target and two float64s (20 B).
func TestGraphMemory(t *testing.T) {
	dir := dataDir(t)

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	g, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	runtime.GC()
	runtime.ReadMemStats(&after)
	held := after.HeapAlloc - before.HeapAlloc

	perNode := float64(held) / float64(g.NodeCount())
	t.Logf("graph resident %.1f MB for %d nodes and %d directed edges (%.0f B/node)",
		float64(held)/1e6, g.NodeCount(), g.EdgeCount(), perNode)
	t.Logf("peak while loading: %.1f MB", float64(after.TotalAlloc-before.TotalAlloc)/1e6)

	// The TypeScript graph costs 365 B/node. Anything near that means the flat
	// layout did not take, and the exercise was pointless.
	if perNode > 200 {
		t.Errorf("%.0f B/node — no better than the slice-per-node layout it replaces", perNode)
	}
	runtime.KeepAlive(g)
}

func BenchmarkLoad(b *testing.B) {
	dir := dataDir(b)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Load(dir); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkRouteAcrossFrance times a long route over the real network, which is
// the work a train's first appearance in the feed triggers.
func BenchmarkRouteAcrossFrance(b *testing.B) {
	g, err := Load(dataDir(b))
	if err != nil {
		b.Fatal(err)
	}
	// Paris Gare de Lyon to Marseille Saint-Charles.
	from, _, okA := g.Nearest(48.8443, 2.3743, 5)
	to, _, okB := g.Nearest(43.3025, 5.3806, 5)
	if !okA || !okB {
		b.Skip("endpoints not on the network")
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if path := g.Route(from, to, 14, true); path == nil {
			b.Fatal("no route")
		}
	}
}
