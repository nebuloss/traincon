// Package train turns a decoded feed entry into everything derivable from it:
// which leg it is on, how late it still is, how recently SNCF actually saw it,
// and where to draw it.
//
// Positions are always derived — SNCF publishes no GPS — so every one carries a
// quality note saying so.
package train

import "traincon/internal/gtfs"

// StockMaxKmh is how fast each kind of train can actually go.
//
// The figures are fleet maxima rather than what any particular unit does:
//
//	tgv    320  the LGV Est and Sud-Europe-Atlantique limit, and what the
//	            current sets are cleared for. Older LGVs are 300.
//	ic     200  Corail stock, and the locomotives that haul it.
//	ter    200  most regional units are 160, but the TER 200 between Strasbourg
//	            and Bâle really does run at 200, and it is one of the trains
//	            this was noticed on. Taking the family maximum rather than the
//	            common one means the cap never contradicts a train that is
//	            genuinely doing it.
//	other  160  navettes and unclassified passenger services.
var StockMaxKmh = map[gtfs.Family]float64{
	gtfs.FamilyTGV:   320,
	gtfs.FamilyIC:    200,
	gtfs.FamilyTER:   200,
	gtfs.FamilyOther: 160,
}

// PlausibleSpeed holds a speed estimate to what the line and the train both
// allow.
//
// The figure shown for a train is not measured — nothing publishes that. It is
// the nominal line-speed profile scaled by how long the timetable gives the
// train for the leg, which turns "what this line allows" into "what this train
// is managing". That scaling has no ceiling of its own, and a train running to
// a tighter schedule than the nominal profile assumes scales straight past
// every real limit: a TER was reported at 266 km/h, on a line limited to 220,
// in stock that cannot exceed 200.
//
// Two ceilings are missing there and both are real. Applying them does not make
// the estimate more accurate — the underlying timetable is saying something odd
// when this bites — but it stops the estimate claiming something that cannot
// have happened.
//
// limitKmh is the line speed where the train is; pass hasLimit false where the
// geometry does not know it. The stock limit still applies: it is a property of
// the train and needs no map.
func PlausibleSpeed(kmh float64, family gtfs.Family, limitKmh float64, hasLimit bool) float64 {
	ceiling, ok := StockMaxKmh[family]
	if !ok {
		ceiling = StockMaxKmh[gtfs.FamilyOther]
	}
	if hasLimit && limitKmh > 0 && limitKmh < ceiling {
		ceiling = limitKmh
	}
	return max(0, min(kmh, ceiling))
}
