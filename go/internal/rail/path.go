package rail

import (
	"container/list"
	"fmt"
	"math"
	"os"
	"strconv"

	"traincon/internal/geo"
)

// How hard a train changes speed, in m/s².
//
// Service values, not emergency ones: a full train accelerates gently and
// brakes gently for comfort. Braking is the stronger of the two, which is why a
// train holds line speed almost to a restriction and then loses it quickly,
// rather than the reverse.
const (
	accelMS2 = 0.4
	brakeMS2 = 0.5
)

// Path is a routed journey between two points, with the profiles needed to say
// where along it a train is at a given moment.
type Path struct {
	// Pts are the vertices, in [lat, lon].
	Pts [][2]float64
	// Cum is cumulative distance at each vertex, km.
	Cum []float64
	// CumT is cumulative nominal traversal time at each vertex, hours.
	CumT []float64
	// SegV is the line speed of each segment, km/h.
	SegV []float64
	// V is the modelled speed at each vertex, km/h — the profile the timing
	// came from.
	V []float64
	// Total is the track distance, km, and Direct the straight line, for the
	// sanity check that rejects absurd detours.
	Total  float64
	Direct float64
}

// speedAndTime builds the speed profile and cumulative time along a path.
//
// The profile obeys three constraints at once: the line speed of every segment,
// the rate the train can gain speed, and the rate it can lose it. Two passes
// give exactly that — forward for acceleration, backward for braking — taking
// the lower at each vertex.
//
// The backward pass is what makes this worth doing. Timing each segment at its
// own limit dropped a train from 300 to 160 km/h the instant it met a
// restriction; a real one brakes well before, and at these rates shedding
// 140 km/h takes about 1.5 km. The same pass makes it arrive at rest and the
// forward pass makes it leave at rest, so the start and stop ramps fall out of
// the physics instead of being a taper bolted on afterwards.
//
// Absolute values do not matter, only the shape: the profile is scaled onto the
// timetable's actual leg duration.
func speedAndTime(cum, segV []float64) (kmh, cumT []float64) {
	n := len(cum)
	if n < 2 {
		if n == 1 {
			return []float64{0}, []float64{0}
		}
		return nil, nil
	}

	// Metres per second while building; converted on the way out.
	v := make([]float64, n)

	// Forward: leaves at rest, and cannot gain speed faster than it accelerates.
	// The ceiling at a vertex is the lower of the two segments meeting there.
	for i := 1; i < n; i++ {
		limit := segV[i-1]
		if i < n-1 && segV[i] < limit {
			limit = segV[i]
		}
		if limit <= 0 {
			limit = defaultSpeedKmh
		}
		dx := math.Max(0, (cum[i]-cum[i-1])*1000)
		reach := math.Sqrt(v[i-1]*v[i-1] + 2*accelMS2*dx)
		v[i] = math.Min(reach, limit/3.6)
	}

	// Backward: arrives at rest, and must already be slow enough for what is
	// ahead — a lower limit, or the stop itself.
	v[n-1] = 0
	for i := n - 2; i >= 0; i-- {
		dx := math.Max(0, (cum[i+1]-cum[i])*1000)
		if able := math.Sqrt(v[i+1]*v[i+1] + 2*brakeMS2*dx); able < v[i] {
			v[i] = able
		}
	}

	kmh = make([]float64, n)
	cumT = make([]float64, n)
	for i := 1; i < n; i++ {
		dx := math.Max(0, (cum[i]-cum[i-1])*1000)
		// Mean of the endpoints, floored: on a single-segment path both ends
		// are zero, and dividing by that would be an infinite crossing time.
		mean := math.Max(2, (v[i-1]+v[i])/2)
		cumT[i] = cumT[i-1] + dx/mean/3600
		kmh[i] = v[i] * 3.6
	}
	return kmh, cumT
}

// pathCacheMaxPoints is what the routed-path cache may hold, counted in
// vertices rather than paths.
//
// Vertices, because paths differ by orders of magnitude: a suburban hop is a
// few dozen and Bordeaux–Paris is thousands, so a cap on the number of paths
// could mean 5 MB or 150 MB depending on which trains happened to run. At the
// measured 573 vertices per path, the old cap of 2 500 paths was ~1.4 million
// vertices, and that is what exhausted the heap on the TypeScript server.
var pathCacheMaxPoints = envInt("RAIL_PATH_POINTS", 400_000)

// envInt reads an operational knob, falling back where it is unset or unusable.
// A container smaller than this one was sized for is the reason it is a knob at
// all: the cache is the largest thing that grows after boot.
func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return fallback
}

// pathCacheMaxEntries is a secondary guard, for a run of unusually short paths.
const pathCacheMaxEntries = 4000

type cacheEntry struct {
	key  string
	path *Path // nil is a cached "no route", which is worth remembering too
}

// Cache is a bounded store of routed paths, evicting least-recently-used.
//
// Not safe for concurrent use; the store that owns it serialises access.
type Cache struct {
	entries map[string]*list.Element
	order   *list.List // front is coldest
	points  int
}

// NewCache returns an empty path cache.
func NewCache() *Cache {
	return &Cache{entries: make(map[string]*list.Element), order: list.New()}
}

// Stats reports what the cache is holding, for the memory diagnostics.
func (c *Cache) Stats() (paths, points int) {
	return len(c.entries), c.points
}

func (c *Cache) get(key string) (*Path, bool) {
	el, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToBack(el) // used, so no longer the coldest
	return el.Value.(*cacheEntry).path, true
}

func (c *Cache) put(key string, p *Path) {
	el := c.order.PushBack(&cacheEntry{key: key, path: p})
	c.entries[key] = el
	if p != nil {
		c.points += len(p.Pts)
	}
	for (c.points > pathCacheMaxPoints || len(c.entries) > pathCacheMaxEntries) && c.order.Len() > 0 {
		oldest := c.order.Front()
		e := oldest.Value.(*cacheEntry)
		if e.path != nil {
			c.points -= len(e.path.Pts)
		}
		c.order.Remove(oldest)
		delete(c.entries, e.key)
	}
	if c.points < 0 {
		c.points = 0
	}
}

// Path returns the track-following polyline between two coordinates, with the
// distance and time profiles that let a position be looked up by elapsed
// fraction. It returns nil when the two cannot sensibly be joined by rail.
//
// cache may be nil, in which case every call routes afresh.
func (g *Graph) Path(cache *Cache, aLat, aLon, bLat, bLon float64, allowFast bool) *Path {
	key := fmt.Sprintf("%.4f,%.4f|%.4f,%.4f|%t", aLat, aLon, bLat, bLon, allowFast)
	if cache != nil {
		if p, ok := cache.get(key); ok {
			return p
		}
	}
	p := g.routePath(aLat, aLon, bLat, bLon, allowFast)
	if cache != nil {
		cache.put(key, p)
	}
	return p
}

func (g *Graph) routePath(aLat, aLon, bLat, bLon float64, allowFast bool) *Path {
	from, _, okA := g.Nearest(aLat, aLon, 5)
	to, _, okB := g.Nearest(bLat, bLon, 5)
	if !okA || !okB {
		return nil
	}

	ids := g.Route(from, to, 14, allowFast)
	if ids == nil && !allowFast {
		// Kept off the high-speed lines where the train does not belong, but
		// not at the price of no route at all: the network data has gaps, and a
		// leg that only connects through a LGV is better drawn on the LGV than
		// reduced to a straight line across country.
		ids = g.Route(from, to, 14, true)
	}
	if ids == nil {
		return nil
	}

	// Anchor the ends on the true station coordinates; the stub segments
	// inherit the speed of the section they join.
	pts := make([][2]float64, 0, len(ids)+2)
	pts = append(pts, [2]float64{aLat, aLon})
	for _, id := range ids {
		pts = append(pts, [2]float64{g.lat[id], g.lon[id]})
	}
	pts = append(pts, [2]float64{bLat, bLon})

	segV := make([]float64, 0, len(pts)-1)
	segV = append(segV, 0) // placeholder for the leading stub
	for i := 1; i < len(ids); i++ {
		segV = append(segV, g.speedBetween(ids[i-1], ids[i]))
	}
	if len(segV) > 1 {
		segV[0] = segV[1]
	} else {
		segV[0] = defaultSpeedKmh
	}
	segV = append(segV, segV[len(segV)-1]) // trailing stub

	cum := make([]float64, len(pts))
	for i := 1; i < len(pts); i++ {
		cum[i] = cum[i-1] + geo.HaversineAt(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1])
	}
	total := cum[len(cum)-1]
	direct := geo.HaversineAt(aLat, aLon, bLat, bLon)

	// Reject nonsense detours: a disconnected network sending a train round
	// France to reach the next station.
	slack := 1.8
	switch {
	case direct < 15:
		slack = 3.2
	case direct < 60:
		slack = 2.2
	}
	if total > math.Max(12, direct*slack) {
		return nil
	}

	v, cumT := speedAndTime(cum, segV)
	return &Path{Pts: pts, Cum: cum, CumT: cumT, SegV: segV, V: v, Total: total, Direct: direct}
}

// speedBetween recovers the line speed of the edge joining two adjacent nodes.
func (g *Graph) speedBetween(a, b int32) float64 {
	for e := g.rowStart[a]; e < g.rowStart[a+1]; e++ {
		if g.edgeTo[e] == b {
			return math.Round(g.edgeKmh(e))
		}
	}
	return defaultSpeedKmh
}
