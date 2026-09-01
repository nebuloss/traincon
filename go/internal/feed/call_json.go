package feed

import "encoding/json"

// wireCall is a call in the shape the API contract defines.
//
// The struct itself keeps flat int64s and separate "has" flags, because a call
// is built ten thousand times per refresh and pointers would mean an allocation
// each. The wire format is a different question: the client has always seen
// arrival and departure as nullable numbers, so absence is null there rather
// than a zero with a flag beside it.
type wireCall struct {
	StopID    string  `json:"stopId"`
	Name      string  `json:"name"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	Arrival   *int64  `json:"arrival"`
	Departure *int64  `json:"departure"`
	Time      int64   `json:"time"`
	Delay     int64   `json:"delay"`
	Skipped   bool    `json:"skipped"`
}

// MarshalJSON writes a call in the contract's shape.
func (c Call) MarshalJSON() ([]byte, error) {
	out := wireCall{
		StopID: c.StopID, Name: c.Name, Lat: c.Lat, Lon: c.Lon,
		Time: c.Time, Delay: c.Delay, Skipped: c.Skipped,
	}
	if c.HasArrival {
		out.Arrival = &c.Arrival
	}
	if c.HasDeparture {
		out.Departure = &c.Departure
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads that same shape back, for the snapshot the store writes.
func (c *Call) UnmarshalJSON(data []byte) error {
	var in wireCall
	if err := json.Unmarshal(data, &in); err != nil {
		return err
	}
	*c = Call{
		StopID: in.StopID, Name: in.Name, Lat: in.Lat, Lon: in.Lon,
		Time: in.Time, Delay: in.Delay, Skipped: in.Skipped,
	}
	if in.Arrival != nil {
		c.Arrival, c.HasArrival = *in.Arrival, true
	}
	if in.Departure != nil {
		c.Departure, c.HasDeparture = *in.Departure, true
	}
	return nil
}
