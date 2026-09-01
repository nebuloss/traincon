// Package geo holds the great-circle helpers shared by the rail graph and the
// position engine.
//
// Distances are kilometres and bearings are degrees clockwise from north,
// matching the units the rest of the server speaks. Nothing here allocates:
// these run inside the routing inner loop, over a graph of 181 290 nodes.
package geo

import "math"

// EarthKm is the mean Earth radius used for every distance in the project.
// One value, so a path's length and a train's progress along it can never
// disagree by a rounding of the radius.
const EarthKm = 6371

// Point is a WGS84 coordinate.
type Point struct {
	Lat float64
	Lon float64
}

func rad(d float64) float64 { return d * math.Pi / 180 }
func deg(r float64) float64 { return r * 180 / math.Pi }

// Haversine returns the great-circle distance between two points, in km.
func Haversine(a, b Point) float64 {
	return HaversineAt(a.Lat, a.Lon, b.Lat, b.Lon)
}

// HaversineAt is Haversine on bare coordinates, for callers holding parallel
// arrays rather than structs — which, in the graph, is all of them.
func HaversineAt(aLat, aLon, bLat, bLon float64) float64 {
	dLat := rad(bLat - aLat)
	dLon := rad(bLon - aLon)
	sinLat := math.Sin(dLat / 2)
	sinLon := math.Sin(dLon / 2)
	h := sinLat*sinLat + math.Cos(rad(aLat))*math.Cos(rad(bLat))*sinLon*sinLon
	return 2 * EarthKm * math.Asin(math.Sqrt(h))
}

// Bearing returns the initial bearing from a to b, in degrees clockwise from
// north.
func Bearing(a, b Point) float64 {
	dLon := rad(b.Lon - a.Lon)
	y := math.Sin(dLon) * math.Cos(rad(b.Lat))
	x := math.Cos(rad(a.Lat))*math.Sin(rad(b.Lat)) -
		math.Sin(rad(a.Lat))*math.Cos(rad(b.Lat))*math.Cos(dLon)
	return math.Mod(deg(math.Atan2(y, x))+360, 360)
}

// GreatCircle returns the point at fraction f along the great circle from a
// to b. f is not clamped: the caller decides whether overshooting is meaningful.
func GreatCircle(a, b Point, f float64) Point {
	d := Haversine(a, b) / EarthKm
	if d < 1e-9 {
		return a
	}
	sinD := math.Sin(d)
	ca := math.Sin((1-f)*d) / sinD
	cb := math.Sin(f*d) / sinD
	x := ca*math.Cos(rad(a.Lat))*math.Cos(rad(a.Lon)) + cb*math.Cos(rad(b.Lat))*math.Cos(rad(b.Lon))
	y := ca*math.Cos(rad(a.Lat))*math.Sin(rad(a.Lon)) + cb*math.Cos(rad(b.Lat))*math.Sin(rad(b.Lon))
	z := ca*math.Sin(rad(a.Lat)) + cb*math.Sin(rad(b.Lat))
	return Point{Lat: deg(math.Atan2(z, math.Hypot(x, y))), Lon: deg(math.Atan2(y, x))}
}
