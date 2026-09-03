package gtfs

import (
	"archive/zip"
	"hash/maphash"
	"slices"
)

// Coupling, read off the timetable rather than guessed at from behaviour.
//
// Two trains cannot occupy one running line at one moment. So when the schedule
// books two different numbers out of the same station at the same second and
// into the next station at the same second, they were on the same piece of
// railway at the same time — and on a line with one track each way, which is
// almost all of the French network, that is only possible coupled.
//
// A whole leg is required rather than a stop held in common. Two trains do
// stand in one station at one minute, at different platforms, all the time; the
// terminus of two journeys that merely finish together is the commonest case of
// all. What they do not do is leave together and arrive together.
//
// Measured on the real timetable, 39,578 trips: 1,893 number pairs share a leg,
// 1,607 of them compatible stock. Against the previous rule — same terminus,
// same booked minute, same next stop, all inferred live — 11 of the 18 sets it
// was reporting have no shared leg at all, including three-way groupings that
// cannot be a unité multiple. Intercités de Nuit 5772 from Nice and 5792 from
// Briançon share no leg: they meet only at Paris-Austerlitz, as the terminus of
// both, a hundred kilometres and two different lines apart until then.
//
// The count of shared legs says nothing about how sure this is — a coupled set
// running non-stop Strasbourg to Paris-Est shares exactly one, because it calls
// nowhere in between. One is enough.
type coupledKey = uint64

// slotMember is one train number booked over a leg, with what it is made of.
type slotMember struct {
	number string
	// stock is the service marker from the trip id — ICN, OUI, TER and so on.
	// A unité multiple is two units of one type: an Intercités cannot be
	// coupled to a TER whatever the timetable happens to say.
	stock string
}

// buildCoupled returns, for each train number, the numbers the timetable books
// it to run joined to.
func buildCoupled(zr *zip.Reader) (map[string][]string, error) {
	// Which dates each service runs, as a bitset over the feed's own calendar.
	// Two numbers that never run on the same day cannot be one train, however
	// well their times line up.
	dayOf := make(map[string]int)
	runs := make(map[string][]uint64)
	err := eachRow(zr, "calendar_dates.txt",
		[]string{"service_id", "date", "exception_type"}, func(v []string) {
			if v[2] != "1" { // 1 is "runs on this date", 2 is "does not"
				return
			}
			d, ok := dayOf[v[1]]
			if !ok {
				d = len(dayOf)
				dayOf[v[1]] = d
			}
			b := runs[v[0]]
			for len(b) <= d/64 {
				b = append(b, 0)
			}
			b[d/64] |= 1 << uint(d%64)
			runs[v[0]] = b
		})
	if err != nil {
		return nil, err
	}

	// Each trip's number and stock, and the days that number runs at all.
	type tripMeta struct{ number, stock string }
	meta := make(map[string]tripMeta)
	days := make(map[string][]uint64)
	err = eachRow(zr, "trips.txt",
		[]string{"trip_id", "service_id", "trip_headsign"}, func(v []string) {
			trip, service, number := v[0], v[1], v[2]
			if number == "" {
				return
			}
			stock := ""
			if m := servicePattern.FindStringSubmatch(trip); m != nil {
				stock = m[1]
			}
			meta[trip] = tripMeta{number: number, stock: stock}

			b, on := days[number], runs[service]
			for len(b) < len(on) {
				b = append(b, 0)
			}
			for i, w := range on {
				b[i] |= w
			}
			days[number] = b
		})
	if err != nil {
		return nil, err
	}

	// Who is booked over which leg. Keyed by a hash rather than by the text,
	// because there is one of these per call in the country and the keys would
	// otherwise be the largest thing here.
	seed := maphash.MakeSeed()
	legs := make(map[coupledKey][]slotMember)

	var prevTrip, prevStop, prevDep string
	err = eachRow(zr, "stop_times.txt",
		[]string{"trip_id", "arrival_time", "departure_time", "stop_id"},
		func(v []string) {
			trip, arrival, departure, stop := v[0], v[1], v[2], v[3]
			// stop_times is grouped by trip and ordered within it, so the leg
			// is simply this call and the one before — as long as both belong
			// to the same trip.
			from, dep := prevStop, prevDep
			same := trip == prevTrip
			prevTrip, prevStop, prevDep = trip, stop, departure
			if !same || dep == "" || arrival == "" {
				return
			}
			m, ok := meta[trip]
			if !ok {
				return
			}

			var h maphash.Hash
			h.SetSeed(seed)
			h.WriteString(from)
			h.WriteByte(0)
			h.WriteString(dep)
			h.WriteByte(0)
			h.WriteString(stop)
			h.WriteByte(0)
			h.WriteString(arrival)
			key := h.Sum64()

			// The same number on another day is the same booking, not another
			// train on the section.
			for _, s := range legs[key] {
				if s.number == m.number {
					return
				}
			}
			legs[key] = append(legs[key], slotMember{number: m.number, stock: m.stock})
		})
	if err != nil {
		return nil, err
	}

	joined := make(map[[2]string]struct{})
	for _, on := range legs {
		if len(on) < 2 {
			continue
		}
		for i := range on {
			for j := i + 1; j < len(on); j++ {
				a, b := on[i], on[j]
				if a.stock != b.stock || a.stock == "" {
					continue
				}
				pair := [2]string{a.number, b.number}
				if pair[0] > pair[1] {
					pair[0], pair[1] = pair[1], pair[0]
				}
				joined[pair] = struct{}{}
			}
		}
	}

	out := make(map[string][]string)
	for pair := range joined {
		if !overlap(days[pair[0]], days[pair[1]]) {
			continue
		}
		out[pair[0]] = append(out[pair[0]], pair[1])
		out[pair[1]] = append(out[pair[1]], pair[0])
	}
	for _, v := range out {
		slices.Sort(v)
	}
	return out, nil
}

// overlap reports whether two numbers ever run on the same day.
func overlap(a, b []uint64) bool {
	for i := range min(len(a), len(b)) {
		if a[i]&b[i] != 0 {
			return true
		}
	}
	return false
}
