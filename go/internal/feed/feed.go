// Package feed reads the SNCF GTFS-RT trip updates and normalises them into
// the shape the rest of the server works in.
//
// The feed is keyless and public, refreshed about every two minutes, and
// forecasts roughly eight hours ahead. It is also down often enough that
// retries, a replay mode and a fallback capture all earn their place.
package feed

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"time"

	rt "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"

	"traincon/internal/gtfs"
)

// DefaultURL is the public proxy for SNCF's trip updates.
const DefaultURL = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates"

// tripID reads the operator and train number from a feed entity id, e.g.
// "OCETGV12345F..." gives "TGV" and "12345".
var tripID = regexp.MustCompile(`^OCE([A-Z]{2})(\d+)F`)

// Call is one scheduled stop of a train, as the feed reports it.
type Call struct {
	StopID string
	Name   string
	Lat    float64
	Lon    float64
	// Arrival and Departure are epoch seconds, or zero when the feed omits
	// that side of the call. Present reports which.
	Arrival      int64
	Departure    int64
	HasArrival   bool
	HasDeparture bool
	// Time is whichever of the two the feed gave, and is what the calls are
	// ordered by.
	Time int64
	// Delay is seconds behind schedule; negative means early.
	Delay   int64
	Skipped bool
}

// Train is one decoded trip update, before the store enriches it.
type Train struct {
	ID          string
	Number      string
	Service     string
	Line        string
	Origin      string
	Destination string
	Calls       []Call
	Cancelled   bool
	MaxDelay    int64
	LastDelay   int64
	FeedTS      int64
}

// Result is one decode of the feed.
type Result struct {
	Trains []Train
	FeedTS int64
	// Replay is true when the data came from a capture rather than the live
	// feed. Demo data must never be presented as live.
	Replay bool
	Shift  int64
}

// ShiftMode decides whether a replayed capture is rebased onto the present.
type ShiftMode string

const (
	// ShiftAuto moves a capture's clock so it reads as happening now.
	ShiftAuto ShiftMode = "auto"
	// ShiftNone keeps the capture's own clock, which is what a test wants.
	ShiftNone ShiftMode = "none"
)

// Client fetches and decodes the feed.
type Client struct {
	URL string
	// File replays a captured .pb instead of calling the network.
	File string
	// Fallback is served if the network fails outright, always marked replay.
	Fallback string
	Shift    ShiftMode
	Attempts int
	Timeout  time.Duration
	// HTTP is the client used for fetches; nil means http.DefaultClient.
	HTTP *http.Client
}

// New returns a Client configured from the environment, with the defaults the
// server runs on.
func New() *Client {
	c := &Client{
		URL:      envOr("SNCF_FEED_URL", DefaultURL),
		File:     os.Getenv("SNCF_FEED_FILE"),
		Fallback: os.Getenv("SNCF_FEED_FALLBACK"),
		Shift:    ShiftMode(envOr("SNCF_FEED_SHIFT", string(ShiftAuto))),
		Attempts: 3,
		Timeout:  20 * time.Second,
	}
	return c
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// Load fetches the feed and turns it into trains.
//
// statics supplies the stop names and coordinates the feed refers to only by
// id, and the service marker for each train number.
func (c *Client) Load(ctx context.Context, statics *gtfs.Static) (*Result, error) {
	msg, replay, err := c.message(ctx)
	if err != nil {
		return nil, err
	}

	rawTS := int64(msg.GetHeader().GetTimestamp())
	var shift int64
	if replay && c.Shift != ShiftNone {
		if c.Shift == ShiftAuto {
			shift = time.Now().Unix() - rawTS
		}
	}
	feedTS := rawTS + shift

	trains := make([]Train, 0, len(msg.GetEntity()))
	for _, e := range msg.GetEntity() {
		if t, ok := buildTrain(e, statics, feedTS, shift); ok {
			trains = append(trains, t)
		}
	}
	return &Result{Trains: trains, FeedTS: feedTS, Replay: replay, Shift: shift}, nil
}

// message returns the decoded feed, and whether it came from a capture.
//
// The proxy resets connections often enough that one attempt is not enough to
// boot on, so this retries with backoff and gives each attempt a deadline: a
// hung socket must not stall the poll loop behind it.
func (c *Client) message(ctx context.Context) (*rt.FeedMessage, bool, error) {
	if c.File != "" {
		msg, err := decodeFile(c.File)
		return msg, true, err
	}

	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	attempts := max(1, c.Attempts)

	var lastErr error
	for i := range attempts {
		msg, err := c.attempt(ctx, client)
		if err == nil {
			return msg, false, nil
		}
		lastErr = err
		if i < attempts-1 {
			delay := time.Duration(500*(1<<i)) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, false, ctx.Err()
			case <-time.After(delay):
			}
		}
	}

	// Last resort: serve a capture rather than an empty network. Always
	// reported as replay, so demo data cannot masquerade as live.
	if c.Fallback != "" {
		if msg, err := decodeFile(c.Fallback); err == nil {
			return msg, true, nil
		}
	}
	return nil, false, fmt.Errorf("feed: unavailable after %d attempts: %w", attempts, lastErr)
}

func (c *Client) attempt(ctx context.Context, client *http.Client) (*rt.FeedMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept-Encoding", "gzip")

	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	// Drain before closing: an abandoned body holds its connection out of the
	// pool until something finalises it.
	defer func() {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var msg rt.FeedMessage
	if err := proto.Unmarshal(body, &msg); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &msg, nil
}

func decodeFile(path string) (*rt.FeedMessage, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("feed: %s: %w", path, err)
	}
	var msg rt.FeedMessage
	if err := proto.Unmarshal(body, &msg); err != nil {
		return nil, fmt.Errorf("feed: %s: %w", path, err)
	}
	return &msg, nil
}

// buildTrain normalises one trip update. Every time in the result is SNCF's own
// live forecast — nothing here is interpolated.
//
// It reports false for an entity that carries no usable journey: an id that is
// not a train number, no stop time updates, or fewer than two stops the static
// schedule recognises.
func buildTrain(e *rt.FeedEntity, statics *gtfs.Static, feedTS, shift int64) (Train, bool) {
	m := tripID.FindStringSubmatch(e.GetId())
	tu := e.GetTripUpdate()
	if m == nil || tu == nil || len(tu.GetStopTimeUpdate()) == 0 {
		return Train{}, false
	}

	meta := statics.Trains[m[1]+m[2]]
	calls := make([]Call, 0, len(tu.GetStopTimeUpdate()))
	for _, stu := range tu.GetStopTimeUpdate() {
		stop, known := statics.Stops[stu.GetStopId()]
		if !known {
			continue
		}
		arr, hasArr := eventTime(stu.GetArrival())
		dep, hasDep := eventTime(stu.GetDeparture())

		// The departure is the sortable instant where there is one; a terminus
		// has only an arrival.
		at := dep
		if !hasDep {
			at = arr
		}
		if at == 0 {
			continue
		}

		delay, ok := eventDelay(stu.GetDeparture())
		if !ok {
			delay, _ = eventDelay(stu.GetArrival())
		}

		c := Call{
			StopID:       stu.GetStopId(),
			Name:         stop.Name,
			Lat:          stop.Lat,
			Lon:          stop.Lon,
			HasArrival:   hasArr,
			HasDeparture: hasDep,
			Time:         at + shift,
			Delay:        delay,
			Skipped:      stu.GetScheduleRelationship() == rt.TripUpdate_StopTimeUpdate_SKIPPED,
		}
		if hasArr {
			c.Arrival = arr + shift
		}
		if hasDep {
			c.Departure = dep + shift
		}
		calls = append(calls, c)
	}
	if len(calls) < 2 {
		return Train{}, false
	}
	sortCallsByTime(calls)

	maxDelay, lastDelay := int64(math.MinInt64), calls[len(calls)-1].Delay
	for _, c := range calls {
		if c.Delay > maxDelay {
			maxDelay = c.Delay
		}
	}

	return Train{
		ID:          e.GetId(),
		Number:      m[2],
		Service:     meta.Service,
		Line:        meta.Line,
		Origin:      calls[0].Name,
		Destination: calls[len(calls)-1].Name,
		Calls:       calls,
		Cancelled:   tu.GetTrip().GetScheduleRelationship() == rt.TripDescriptor_CANCELED,
		MaxDelay:    maxDelay,
		LastDelay:   lastDelay,
		FeedTS:      feedTS,
	}, true
}

// eventTime reads a stop time event's instant, reporting whether it carried one.
func eventTime(e *rt.TripUpdate_StopTimeEvent) (int64, bool) {
	if e == nil || e.Time == nil {
		return 0, false
	}
	return e.GetTime(), true
}

// eventDelay reads a stop time event's delay. The second result distinguishes
// "on time" from "not reported", which decides whether the other side of the
// call is consulted instead.
func eventDelay(e *rt.TripUpdate_StopTimeEvent) (int64, bool) {
	if e == nil || e.Delay == nil {
		return 0, false
	}
	return int64(e.GetDelay()), true
}

// sortCallsByTime orders the journey. Insertion sort: the feed lists calls in
// order already, so this almost always makes a single pass.
func sortCallsByTime(calls []Call) {
	for i := 1; i < len(calls); i++ {
		c := calls[i]
		j := i - 1
		for j >= 0 && calls[j].Time > c.Time {
			calls[j+1] = calls[j]
			j--
		}
		calls[j+1] = c
	}
}
