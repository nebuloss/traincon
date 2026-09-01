package rail

import (
	"math"

	"github.com/nebuloss/traincon/internal/geo"
)

const (
	// snapDeg welds track vertices within ~11 m at French latitudes into one
	// node, so two sections meeting at a junction share it.
	snapDeg = 1e-4
	// cellDeg is the spatial bucket for nearest-node lookup, ~5 km.
	cellDeg = 0.05
	// kmPerCell converts a ring count to a distance, for deciding when a
	// widening search cannot improve on what it has found.
	kmPerCell = cellDeg * 111
	// minEdgeKmh floors an edge's weight, so a line recorded at an implausibly
	// low speed cannot dominate the routing.
	minEdgeKmh = 30
)

// Graph is the routing network, held in compressed sparse row form.
//
// The obvious layout — one slice of neighbours per node — costs an object
// header per node, and there are 181 290 of them. Measured on the TypeScript
// server, which uses exactly that shape, the graph occupies 66 MB to hold
// 12.4 MB of numbers: 365 bytes per node for two coordinates and two edges.
//
// Here the adjacency is three flat slices plus a row index. Node n's edges are
// the half-open range rowStart[n]:rowStart[n+1], and every node's edges are
// contiguous, so walking them is a linear scan rather than a pointer chase.
type Graph struct {
	lat, lon []float64

	rowStart []int32   // len = nodes + 1
	edgeTo   []int32   // len = directed edges
	edgeKm   []float64 // length of each edge
	edgeHr   []float64 // nominal traversal time of each edge

	cells map[int64][]int32
}

// NodeCount returns the number of nodes in the graph.
func (g *Graph) NodeCount() int { return len(g.lat) }

// EdgeCount returns the number of directed edges. Every stretch of track
// appears twice, once in each direction.
func (g *Graph) EdgeCount() int { return len(g.edgeTo) }

// At returns a node's coordinates.
func (g *Graph) At(id int32) geo.Point {
	return geo.Point{Lat: g.lat[id], Lon: g.lon[id]}
}

// edgeKmh recovers an edge's line speed from its length and time. The two were
// derived from it, so this returns what it was built with, and saves carrying a
// fourth slice over every edge in the network.
func (g *Graph) edgeKmh(e int32) float64 { return g.edgeKm[e] / g.edgeHr[e] }

// packKey folds two grid coordinates into one map key.
func packKey(a, b int32) int64 { return int64(a)<<32 | int64(uint32(b)) }

func snapKey(lat, lon float64) int64 {
	return packKey(int32(math.Round(lat/snapDeg)), int32(math.Round(lon/snapDeg)))
}

func cellKey(lat, lon float64) int64 {
	return packKey(int32(math.Floor(lat/cellDeg)), int32(math.Floor(lon/cellDeg)))
}

// Builder accumulates nodes and edges, then freezes them into a Graph.
//
// Edges are collected in one flat slice rather than a slice per node: the
// per-node shape is the thing this package exists to avoid, and it would be
// just as expensive held transiently during the build as it is held for the
// life of the process.
type Builder struct {
	lat, lon []float64
	index    map[int64]int32
	degree   []int32
	edges    []builderEdge
	cells    map[int64][]int32
}

type builderEdge struct {
	a, b   int32
	km, hr float64
}

// NewBuilder returns an empty Builder.
func NewBuilder() *Builder {
	return &Builder{index: make(map[int64]int32), cells: make(map[int64][]int32)}
}

// NodeAt returns the id of the node at these coordinates, creating it if this
// is the first time the position has been seen.
func (b *Builder) NodeAt(lat, lon float64) int32 {
	k := snapKey(lat, lon)
	if id, ok := b.index[k]; ok {
		return id
	}
	id := int32(len(b.lat))
	b.lat = append(b.lat, lat)
	b.lon = append(b.lon, lon)
	b.degree = append(b.degree, 0)
	b.index[k] = id
	c := cellKey(lat, lon)
	b.cells[c] = append(b.cells[c], id)
	return id
}

// Link joins two nodes in both directions, weighted by the time the line's
// speed implies. A zero-length or self link is ignored.
func (b *Builder) Link(a, c int32, kmh float64) {
	if a == c {
		return
	}
	km := geo.HaversineAt(b.lat[a], b.lon[a], b.lat[c], b.lon[c])
	if km <= 0 {
		return
	}
	hr := km / math.Max(minEdgeKmh, kmh)
	b.edges = append(b.edges, builderEdge{a: a, b: c, km: km, hr: hr})
	b.edges = append(b.edges, builderEdge{a: c, b: a, km: km, hr: hr})
	b.degree[a]++
	b.degree[c]++
}

// Stitch welds gaps between separate LineStrings.
//
// The RFN export ships each line section as its own feature, and adjacent
// sections rarely share an exact vertex. Without this the graph is a pile of
// disconnected fragments and obvious routes fail — Mulhouse to Colmar among
// them. Only dangling ends are considered, so a junction is never invented in
// the middle of a line, and the welds are weighted slowly so routing does not
// prefer them.
//
// It returns the number of welds made.
func (b *Builder) Stitch(toleranceKm float64) int {
	var ends []int32
	for id, d := range b.degree {
		if d <= 1 {
			ends = append(ends, int32(id))
		}
	}

	// Which nodes an end is already joined to, so a weld cannot duplicate a
	// link. Built once for the ends rather than rescanned per candidate.
	joined := make(map[int64]struct{}, len(b.edges))
	for _, e := range b.edges {
		joined[packKey(e.a, e.b)] = struct{}{}
	}

	welded := 0
	for _, id := range ends {
		if b.degree[id] > 1 {
			continue // an earlier weld already served this end
		}
		lat, lon := b.lat[id], b.lon[id]
		ci := int32(math.Floor(lat / cellDeg))
		cj := int32(math.Floor(lon / cellDeg))

		best, bestKm := int32(-1), math.Inf(1)
		for i := ci - 1; i <= ci+1; i++ {
			for j := cj - 1; j <= cj+1; j++ {
				for _, other := range b.cells[packKey(i, j)] {
					if other == id {
						continue
					}
					if _, ok := joined[packKey(id, other)]; ok {
						continue
					}
					km := geo.HaversineAt(lat, lon, b.lat[other], b.lon[other])
					if km < bestKm {
						bestKm, best = km, other
					}
				}
			}
		}
		if best >= 0 && bestKm <= toleranceKm {
			b.Link(id, best, 60)
			joined[packKey(id, best)] = struct{}{}
			joined[packKey(best, id)] = struct{}{}
			welded++
		}
	}
	return welded
}

// Build freezes the accumulated nodes and edges into a Graph.
//
// Counting sort by source node: one pass to place each node's range, one to
// scatter the edges into it. The builder's edge slice is dropped on return, so
// the peak is the flat edges plus the finished arrays, never a per-node one.
func (b *Builder) Build() *Graph {
	n := len(b.lat)
	g := &Graph{
		lat:      b.lat,
		lon:      b.lon,
		rowStart: make([]int32, n+1),
		edgeTo:   make([]int32, len(b.edges)),
		edgeKm:   make([]float64, len(b.edges)),
		edgeHr:   make([]float64, len(b.edges)),
		cells:    b.cells,
	}

	for _, e := range b.edges {
		g.rowStart[e.a+1]++
	}
	for i := 1; i <= n; i++ {
		g.rowStart[i] += g.rowStart[i-1]
	}

	at := make([]int32, n)
	copy(at, g.rowStart[:n])
	for _, e := range b.edges {
		p := at[e.a]
		g.edgeTo[p] = e.b
		g.edgeKm[p] = e.km
		g.edgeHr[p] = e.hr
		at[e.a]++
	}

	b.edges = nil
	b.index = nil
	b.degree = nil
	return g
}

// Nearest returns the closest node to a point, and how far away it is, or false
// when nothing is within maxKm.
//
// The search widens a ring at a time and stops as soon as the best candidate is
// closer than the next ring could possibly bring, so a point over open country
// does not scan the whole network.
func (g *Graph) Nearest(lat, lon float64, maxKm float64) (id int32, distKm float64, ok bool) {
	ci := int32(math.Floor(lat / cellDeg))
	cj := int32(math.Floor(lon / cellDeg))
	rings := int32(math.Max(1, math.Ceil(maxKm/5)+1))

	best, bestKm := int32(-1), math.Inf(1)
	for r := int32(0); r <= rings; r++ {
		for i := ci - r; i <= ci+r; i++ {
			for j := cj - r; j <= cj+r; j++ {
				// Only the ring itself: the interior was covered by earlier r.
				if r > 0 && abs32(i-ci) != r && abs32(j-cj) != r {
					continue
				}
				for _, id := range g.cells[packKey(i, j)] {
					km := geo.HaversineAt(lat, lon, g.lat[id], g.lon[id])
					if km < bestKm {
						bestKm, best = km, id
					}
				}
			}
		}
		if best >= 0 && bestKm <= float64(r+1)*kmPerCell {
			break
		}
	}
	if best < 0 || bestKm > maxKm {
		return 0, 0, false
	}
	return best, bestKm, true
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// Route returns the fastest path between two nodes, as node ids.
//
// Fastest, not shortest: minimising time over line speeds is what sends a TGV
// down the LGV instead of the shorter classic line beside it. When allowFast is
// false the high-speed lines are excluded outright, which is how stock that may
// not use them is kept off.
//
// It returns nil when the two are not connected, or when every route between
// them would take longer than maxHours — a cap that stops a pathological search
// crossing the country to join two points a disconnected fragment apart.
func (g *Graph) Route(from, to int32, maxHours float64, allowFast bool) []int32 {
	if from == to {
		return []int32{from}
	}
	n := int32(len(g.lat))
	if from < 0 || to < 0 || from >= n || to >= n {
		return nil
	}

	dist := make([]float64, n)
	for i := range dist {
		dist[i] = math.Inf(1)
	}
	prev := make([]int32, n)
	for i := range prev {
		prev[i] = -1
	}
	done := make([]bool, n)

	dist[from] = 0
	pq := nodeQueue{{node: from, hours: 0}}
	for len(pq) > 0 {
		top := pq.pop()
		if done[top.node] {
			continue
		}
		if top.node == to {
			break
		}
		done[top.node] = true

		for e := g.rowStart[top.node]; e < g.rowStart[top.node+1]; e++ {
			next := g.edgeTo[e]
			if done[next] {
				continue
			}
			if !allowFast && g.edgeKmh(e) >= FastKmh {
				continue
			}
			cost := top.hours + g.edgeHr[e]
			if cost > maxHours || cost >= dist[next] {
				continue
			}
			dist[next] = cost
			prev[next] = top.node
			pq.push(queued{node: next, hours: cost})
		}
	}

	if math.IsInf(dist[to], 1) {
		return nil
	}
	var path []int32
	for at := to; at >= 0; at = prev[at] {
		path = append(path, at)
		if at == from {
			break
		}
	}
	if path[len(path)-1] != from {
		return nil
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// queued is one entry of the routing frontier.
type queued struct {
	node  int32
	hours float64
}

// nodeQueue is a min-heap on travel time.
//
// Written out rather than driven through container/heap, whose Push and Pop
// take and return `any`: every entry would be boxed on the way in, and a route
// across France pushes a quarter of a million of them. Entries are never
// updated in place either — a cheaper route to a node pushes a second entry and
// the stale one is skipped when it surfaces, which costs less than tracking
// each node's position in the heap.
type nodeQueue []queued

func (q *nodeQueue) push(v queued) {
	*q = append(*q, v)
	s := *q
	for i := len(s) - 1; i > 0; {
		parent := (i - 1) / 2
		if s[parent].hours <= s[i].hours {
			break
		}
		s[parent], s[i] = s[i], s[parent]
		i = parent
	}
}

func (q *nodeQueue) pop() queued {
	s := *q
	top := s[0]
	last := len(s) - 1
	s[0] = s[last]
	s = s[:last]
	*q = s

	for i := 0; ; {
		left, right := 2*i+1, 2*i+2
		small := i
		if left < len(s) && s[left].hours < s[small].hours {
			small = left
		}
		if right < len(s) && s[right].hours < s[small].hours {
			small = right
		}
		if small == i {
			break
		}
		s[i], s[small] = s[small], s[i]
		i = small
	}
	return top
}
