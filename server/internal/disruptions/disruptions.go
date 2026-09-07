// Package disruptions says why trains are late.
//
// The GTFS-RT export carries delays but no cause, so the reason has to come from
// elsewhere. Navitia publishes a disruption per affected journey with a
// plain-French message — "Obstacle sur la voie", "Défaillance de matériel" — and
// impacted_objects[].pt_object.trip.name is the train number, which is exactly
// the key the store is built on.
//
// Optional: without a key the index stays empty and the rest of the app is
// unaffected. Ranking works either way; only the reason column goes quiet.
//
// Two things drove the design:
//
//   - Sweep, do not query per train. The obvious approach — ask Navitia about
//     the twenty trains being displayed — does not work: filtering
//     vehicle_journeys by has_headsign returns unrelated coach services, 0 hits
//     on 20 known-delayed trains. Paging the whole disruption list and indexing
//     by number matched 72% of them.
//   - The free key allows 5 000 requests a day. A full sweep is ~18 pages, so a
//     15-minute cycle costs ~1 700 a day and leaves room for everything else.
package disruptions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// defaultBase is the Navitia coverage this reads.
	defaultBase = "https://api.sncf.com/v1/coverage/sncf"
	// pageSize is how many disruptions to ask for at once.
	pageSize = 200
	// maxPages is enough for the ~3 500 disruptions seen in practice, with
	// headroom.
	maxPages = 25
	// refreshEvery is the sweep interval, chosen against the daily quota.
	refreshEvery = 15 * time.Minute
	// requestTimeout bounds one page fetch.
	requestTimeout = 20 * time.Second
)

// Disruption is why one train is disrupted today.
type Disruption struct {
	// Reason is the plain-French cause, as SNCF words it.
	Reason string `json:"reason"`
	// Effect is Navitia's code, e.g. SIGNIFICANT_DELAYS, NO_SERVICE.
	Effect string `json:"effect"`
}

// navitia is the part of a Navitia disruption this reads.
type navitia struct {
	Severity struct {
		Effect string `json:"effect"`
	} `json:"severity"`
	Messages []struct {
		Text string `json:"text"`
	} `json:"messages"`
	ImpactedObjects []struct {
		PTObject struct {
			Trip struct {
				Name string `json:"name"`
			} `json:"trip"`
		} `json:"pt_object"`
		ImpactedStops []struct {
			Cause string `json:"cause"`
		} `json:"impacted_stops"`
	} `json:"impacted_objects"`
}

// Index maps train numbers to the reason they are disrupted.
//
// Safe for concurrent use: the sweep runs on a timer while requests read.
type Index struct {
	key  string
	base string
	http *http.Client

	mu        sync.RWMutex
	byNumber  map[string]Disruption
	fetchedAt time.Time
	err       error

	stop chan struct{}
	once sync.Once
}

// New returns an Index configured from the environment. Without SNCF_API_KEY it
// is inert, and every method still answers.
func New() *Index {
	base := os.Getenv("SNCF_API_BASE")
	if base == "" {
		base = defaultBase
	}
	return &Index{
		key:      os.Getenv("SNCF_API_KEY"),
		base:     base,
		http:     &http.Client{},
		byNumber: make(map[string]Disruption),
		stop:     make(chan struct{}),
	}
}

// Enabled reports whether reasons can be shown at all.
func (i *Index) Enabled() bool { return i.key != "" }

// Size reports how many train numbers carry a reason.
func (i *Index) Size() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return len(i.byNumber)
}

// Get returns the reason a train is disrupted, or an empty string.
func (i *Index) Get(number string) (Disruption, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	d, ok := i.byNumber[number]
	return d, ok
}

// Reason is Get reduced to the text, for callers that want only that.
func (i *Index) Reason(number string) string {
	d, _ := i.Get(number)
	return d.Reason
}

// Start begins sweeping in the background, and returns immediately.
func (i *Index) Start(ctx context.Context) {
	if !i.Enabled() {
		return
	}
	go func() {
		if err := i.Refresh(ctx); err != nil {
			slog.Warn("disruptions: first sweep failed", "err", err)
		}
		t := time.NewTicker(refreshEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-i.stop:
				return
			case <-t.C:
				if err := i.Refresh(ctx); err != nil {
					slog.Warn("disruptions: sweep failed", "err", err)
				}
			}
		}
	}()
}

// Stop ends the background sweep.
func (i *Index) Stop() {
	i.once.Do(func() { close(i.stop) })
}

// Refresh rebuilds the index.
//
// Built into a new map and swapped in at the end, so a sweep that fails halfway
// leaves the previous answers in place rather than a partial set: a stale reason
// is better than none, and the ranking must not depend on this call succeeding.
func (i *Index) Refresh(ctx context.Context) error {
	if !i.Enabled() {
		return nil
	}
	next := make(map[string]Disruption)
	for page := range maxPages {
		items, err := i.page(ctx, page)
		if err != nil {
			i.mu.Lock()
			i.err = err
			i.mu.Unlock()
			return err
		}
		if len(items) == 0 {
			break
		}
		for _, d := range items {
			absorb(d, next)
		}
	}

	i.mu.Lock()
	i.byNumber, i.fetchedAt, i.err = next, time.Now(), nil
	i.mu.Unlock()
	return nil
}

// page fetches one page of disruptions.
func (i *Index) page(ctx context.Context, page int) ([]navitia, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	u, err := url.Parse(i.base + "/disruptions")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("count", strconv.Itoa(pageSize))
	q.Set("start_page", strconv.Itoa(page))
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	// Basic auth, token as username and an empty password.
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(i.key+":")))
	req.Header.Set("Accept", "application/json")

	res, err := i.http.Do(req)
	if err != nil {
		return nil, err
	}
	// Drain before closing: an abandoned body holds its connection out of the
	// pool until something finalises it.
	defer func() {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}()

	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("SNCF API key refused (401)")
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("SNCF API quota exhausted (429)")
	default:
		return nil, fmt.Errorf("SNCF API HTTP %d", res.StatusCode)
	}

	var body struct {
		Disruptions []navitia `json:"disruptions"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Disruptions, nil
}

// absorb indexes one disruption under every train number it names.
func absorb(d navitia, into map[string]Disruption) {
	headline := ""
	for _, m := range d.Messages {
		if m.Text != "" {
			headline = m.Text
			break
		}
	}

	for _, obj := range d.ImpactedObjects {
		number := strings.TrimSpace(obj.PTObject.Trip.Name)
		if number == "" {
			continue
		}
		reason := headline
		if reason == "" {
			// The per-stop cause is the same text in practice, but it is
			// present on some disruptions that carry no top-level message.
			for _, s := range obj.ImpactedStops {
				if s.Cause != "" {
					reason = s.Cause
					break
				}
			}
		}
		if reason == "" {
			continue
		}
		// First writer wins: pages come back newest-first, and a train that has
		// had two incidents should show the current one.
		if _, seen := into[number]; !seen {
			into[number] = Disruption{Reason: reason, Effect: d.Severity.Effect}
		}
	}
}
