package rail

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"math"
)

// displayToleranceDeg is how far a vertex may be from the line it is dropped
// from, in degrees.
//
// About 150 m, which is invisible at national zoom and cuts the payload by an
// order of magnitude.
const displayToleranceDeg = 0.0015

// simplify is Ramer–Douglas–Peucker, in degrees.
//
// For drawing only: the routing graph always keeps full precision, because a
// train projected onto a thinned line would sit beside the track rather than on
// it.
func simplify(points [][]float64, tol float64) [][]float64 {
	if len(points) < 3 {
		return points
	}
	keep := make([]bool, len(points))
	keep[0], keep[len(points)-1] = true, true

	type span struct{ lo, hi int }
	stack := []span{{0, len(points) - 1}}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		x1, y1 := points[s.lo][0], points[s.lo][1]
		x2, y2 := points[s.hi][0], points[s.hi][1]
		dx, dy := x2-x1, y2-y1
		den := dx*dx + dy*dy

		best, bestD := -1, 0.0
		for i := s.lo + 1; i < s.hi; i++ {
			x, y := points[i][0], points[i][1]
			var d float64
			if den == 0 {
				d = math.Hypot(x-x1, y-y1)
			} else {
				t := math.Min(1, math.Max(0, ((x-x1)*dx+(y-y1)*dy)/den))
				d = math.Hypot(x-(x1+t*dx), y-(y1+t*dy))
			}
			if d > bestD {
				bestD, best = d, i
			}
		}
		if bestD > tol && best >= 0 {
			keep[best] = true
			stack = append(stack, span{s.lo, best}, span{best, s.hi})
		}
	}

	out := points[:0:0]
	for i, k := range keep {
		if k {
			out = append(out, points[i])
		}
	}
	return out
}

// displayFeature is one drawn line of the in-service network.
type displayFeature struct {
	Type     string `json:"type"`
	Geometry struct {
		Type        string      `json:"type"`
		Coordinates [][]float64 `json:"coordinates"`
	} `json:"geometry"`
	Properties struct {
		// V is the line speed, and HS marks it as a high-speed line — which is
		// what separates LGV from classic track on the map.
		V  float64 `json:"v"`
		HS int     `json:"hs"`
	} `json:"properties"`
}

// display accumulates the drawn network while the graph is being built.
type display struct {
	features []displayFeature
}

// add thins one line and keeps it, if enough of it survives to draw.
func (d *display) add(line [][]float64, kmh float64) {
	pts := simplify(line, displayToleranceDeg)
	if len(pts) < 2 {
		return
	}
	coords := make([][]float64, len(pts))
	for i, c := range pts {
		// Five decimals is about a metre, far finer than a national map shows.
		coords[i] = []float64{math.Round(c[0]*1e5) / 1e5, math.Round(c[1]*1e5) / 1e5}
	}
	var f displayFeature
	f.Type = "Feature"
	f.Geometry.Type = "LineString"
	f.Geometry.Coordinates = coords
	f.Properties.V = kmh
	if kmh >= FastKmh {
		f.Properties.HS = 1
	}
	d.features = append(d.features, f)
}

// gzipped encodes the collection once, at boot.
//
// Only the compressed bytes are kept: the parsed collection is fifteen thousand
// line strings, and holding it for the life of the process to serve something
// that never changes would be paying rent on a constant.
func (d *display) gzipped() []byte {
	if len(d.features) == 0 {
		return nil
	}
	body, err := json.Marshal(struct {
		Type     string           `json:"type"`
		Features []displayFeature `json:"features"`
	}{Type: "FeatureCollection", Features: d.features})
	if err != nil {
		return nil
	}

	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil
	}
	if _, err := zw.Write(body); err != nil {
		return nil
	}
	if err := zw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}
