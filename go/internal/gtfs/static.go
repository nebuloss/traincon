package gtfs

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// StaticURL is the SNCF open-data export of the national schedule.
const StaticURL = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip"

// MaxAge is how long a downloaded archive, and the tables built from it, are
// considered current.
//
// This constant used to kill the process. The tables are reloaded on the first
// poll after they pass this age, and the reload allocated more than the heap
// had left: the run that died had been up 43 215 548 ms against a window of
// 43 200 000, and went 15.5 seconds into the poll that followed. Nothing here
// accumulates — the cost was all transient — so the loader below is written to
// keep its peak close to what it returns.
const MaxAge = 12 * time.Hour

// Stop is one GTFS stop: a platform, a bus stop, or a station's parent record.
type Stop struct {
	ID   string
	Name string
	Lat  float64
	Lon  float64
	// UIC is the national station code shared by every stop_id at the same
	// physical station, or "" for a stop that carries none.
	UIC string
}

// Station is a physical station: the several stop_ids that share one UIC code.
//
// A single station appears in the feed under a StopArea plus one StopPoint per
// operator ("OCETGV INOUI-87673202", "OCEOUIGO-…"). Grouping them is what lets
// a departure board show every operator's trains rather than one operator's.
type Station struct {
	UIC     string
	Name    string
	Lat     float64
	Lon     float64
	StopIDs []string
}

// TrainMeta is what the static schedule knows about a train number: which
// service operates it, and the name of its line.
type TrainMeta struct {
	Number  string
	Service string
	Line    string
}

// Static is the loaded schedule. It is read-only once built, and shared across
// requests without copying.
type Static struct {
	Stops    map[string]Stop
	Stations map[string]*Station
	Trains   map[string]TrainMeta
	// Coupled maps a train number to the numbers the timetable books it to run
	// joined to. Read off the schedule rather than inferred from behaviour —
	// see coupled.go for what makes it certain.
	Coupled  map[string][]string
	LoadedAt time.Time
}

// CoupledWith returns the numbers this train is booked to run joined to.
func (s *Static) CoupledWith(number string) []string {
	if s == nil {
		return nil
	}
	return s.Coupled[number]
}

// Joined reports whether the timetable books these two as one physical train.
func (s *Static) Joined(a, b string) bool {
	if s == nil {
		return false
	}
	for _, n := range s.Coupled[a] {
		if n == b {
			return true
		}
	}
	return false
}

// Stale reports whether the tables have passed MaxAge and should be rebuilt.
func (s *Static) Stale() bool {
	return time.Since(s.LoadedAt) > MaxAge
}

var (
	// uicPattern pulls the national station code off the tail of a stop_id.
	uicPattern = regexp.MustCompile(`-?(\d{7,8})$`)
	// tripPattern reads the operator and train number from a static trip_id,
	// e.g. "OCETGV12345F..." -> "TGV", "12345".
	tripPattern = regexp.MustCompile(`^OCE([A-Z]{2})(\d+)F`)
	// servicePattern reads the service marker, e.g. "...F:OUI:FR:..." -> "OUI".
	servicePattern = regexp.MustCompile(`F:([A-Z]+):`)
)

// Load downloads the archive if the cached copy has aged out, then builds the
// lookup tables from it.
//
// The archive is read in place: three of its members are streamed straight out
// of the zip, one at a time, and only the seven columns that are used are ever
// materialised. Nothing is extracted to disk, so there is no unzip binary to
// depend on and no temporary files to clean up.
func Load(ctx context.Context, dataDir string) (*Static, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("gtfs: data directory: %w", err)
	}
	archive, err := ensureArchive(ctx, dataDir)
	if err != nil {
		return nil, err
	}

	zr, err := zip.OpenReader(archive)
	if err != nil {
		return nil, fmt.Errorf("gtfs: open %s: %w", archive, err)
	}
	defer zr.Close()

	// routes first: trips needs the line names, and only the names are kept.
	lineOf := make(map[string]string)
	err = eachRow(&zr.Reader, "routes.txt", []string{"route_id", "route_long_name"},
		func(v []string) {
			lineOf[v[0]] = v[1]
		})
	if err != nil {
		return nil, err
	}

	stops := make(map[string]Stop)
	stations := make(map[string]*Station)
	err = eachRow(&zr.Reader, "stops.txt", []string{"stop_id", "stop_name", "stop_lat", "stop_lon"},
		func(v []string) {
			lat, errLat := strconv.ParseFloat(v[2], 64)
			lon, errLon := strconv.ParseFloat(v[3], 64)
			if errLat != nil || errLon != nil {
				return
			}
			id, name := v[0], v[1]
			uic := ""
			if m := uicPattern.FindStringSubmatch(id); m != nil {
				uic = m[1]
			}
			stops[id] = Stop{ID: id, Name: name, Lat: lat, Lon: lon, UIC: uic}
			if uic == "" {
				return
			}
			st, ok := stations[uic]
			if !ok {
				st = &Station{UIC: uic, Name: name, Lat: lat, Lon: lon}
				stations[uic] = st
			}
			st.StopIDs = append(st.StopIDs, id)
			// Prefer the StopArea's own name and coordinates as canonical.
			if strings.HasPrefix(id, "StopArea:") {
				st.Name, st.Lat, st.Lon = name, lat, lon
			}
		})
	if err != nil {
		return nil, err
	}

	// A train number is reused across dates, so the first match wins; the
	// service marker is stable across them.
	trains := make(map[string]TrainMeta)
	err = eachRow(&zr.Reader, "trips.txt", []string{"trip_id", "route_id"}, func(v []string) {
		id := tripPattern.FindStringSubmatch(v[0])
		svc := servicePattern.FindStringSubmatch(v[0])
		if id == nil || svc == nil {
			return
		}
		key := id[1] + id[2]
		if _, seen := trains[key]; seen {
			return
		}
		trains[key] = TrainMeta{Number: id[2], Service: svc[1], Line: lineOf[v[1]]}
	})
	if err != nil {
		return nil, err
	}

	// Which numbers the timetable books to run joined. Read here rather than
	// inferred from the live feed, which had no way to tell a coupled set from
	// two trains booked into one terminus at the same minute.
	coupled, err := buildCoupled(&zr.Reader)
	if err != nil {
		return nil, err
	}

	return &Static{
		Stops: stops, Stations: stations, Trains: trains,
		Coupled: coupled, LoadedAt: time.Now(),
	}, nil
}

// ensureArchive returns the path to a current copy of the archive, downloading
// it only if what is on disk has aged out.
func ensureArchive(ctx context.Context, dataDir string) (string, error) {
	dst := filepath.Join(dataDir, "gtfs.zip")
	if info, err := os.Stat(dst); err == nil && time.Since(info.ModTime()) < MaxAge {
		return dst, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, StaticURL, nil)
	if err != nil {
		return "", fmt.Errorf("gtfs: request: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("gtfs: download: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("gtfs: download: HTTP %d", res.StatusCode)
	}

	// Write beside the target and rename, so an interrupted download can never
	// leave a truncated archive that looks current.
	tmp, err := os.CreateTemp(dataDir, "gtfs-*.zip")
	if err != nil {
		return "", fmt.Errorf("gtfs: temp file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, res.Body); err != nil {
		tmp.Close()
		return "", fmt.Errorf("gtfs: save: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("gtfs: save: %w", err)
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return "", fmt.Errorf("gtfs: install archive: %w", err)
	}
	return dst, nil
}

// eachRow streams one member of the archive, handing the callback just the
// named columns, in the order named.
//
// Nothing accumulates: the reader reuses its record slice and the values are
// copied only by whatever the callback chooses to keep. A column the file does
// not have arrives empty rather than failing, so a schema change costs a field
// instead of the process.
func eachRow(zr *zip.Reader, name string, want []string, fn func([]string)) error {
	f, err := zr.Open(name)
	if err != nil {
		return fmt.Errorf("gtfs: %s: %w", name, err)
	}
	defer f.Close()

	cr := csv.NewReader(f)
	cr.ReuseRecord = true
	cr.FieldsPerRecord = -1 // ragged rows are skipped below, not fatal

	header, err := cr.Read()
	if err != nil {
		return fmt.Errorf("gtfs: %s: header: %w", name, err)
	}
	width := len(header)
	at := make([]int, len(want))
	for i, w := range want {
		at[i] = -1
		for j, h := range header {
			if strings.TrimSpace(h) == w {
				at[i] = j
				break
			}
		}
	}

	out := make([]string, len(want))
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			// A malformed line should not cost the whole table.
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				continue
			}
			return fmt.Errorf("gtfs: %s: %w", name, err)
		}
		if len(rec) != width {
			continue // ragged: taking it would shift every later column
		}
		for i, j := range at {
			if j >= 0 {
				out[i] = rec[j]
			} else {
				out[i] = ""
			}
		}
		fn(out)
	}
}
