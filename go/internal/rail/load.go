package rail

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// inService is the state marking track that actually carries trains.
//
// The RFN export also ships closed, neutralised, downgraded and sold-off lines.
// Routing over those puts trains on rails that have not seen a service in
// decades, so everything else is dropped at load.
const inService = "EXPLOITE"

// stitchToleranceKm is how wide a gap between two dangling line ends may be and
// still be treated as the same junction.
const stitchToleranceKm = 0.12

// Load builds the routing graph from the SNCF Réseau exports in dataDir/geo.
//
// Line speeds are an optimisation, not a requirement: without vmax.json the
// graph still routes, it just weights every edge the same and cannot tell a
// high-speed line from a classic one.
func Load(dataDir string) (*Graph, error) {
	geoDir := filepath.Join(dataDir, "geo")
	speeds, err := loadSpeeds(filepath.Join(geoDir, "vmax.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return loadGeometry(filepath.Join(geoDir, "rfn.geojson"), speeds)
}

// loadSpeeds reads the line-speed export. A missing file is not an error; the
// caller decides whether it can proceed without one.
func loadSpeeds(path string) (*SpeedIndex, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec := json.NewDecoder(bufio.NewReaderSize(f, 1<<20))
	if _, err := dec.Token(); err != nil { // opening [
		return nil, fmt.Errorf("rail: %s: %w", path, err)
	}
	var rows []SpeedRow
	for dec.More() {
		var r SpeedRow
		if err := dec.Decode(&r); err != nil {
			return nil, fmt.Errorf("rail: %s: %w", path, err)
		}
		rows = append(rows, r)
	}
	return NewSpeedIndex(rows), nil
}

// rfnFeature is the part of a network feature this package reads. Everything
// else the export carries is skipped by the decoder rather than allocated.
type rfnFeature struct {
	Geometry *struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	} `json:"geometry"`
	Properties struct {
		CodeLigne string `json:"code_ligne"`
		Mnemo     string `json:"mnemo"`
		PkDebut   string `json:"pk_debut_r"`
		PkFin     string `json:"pk_fin_r"`
	} `json:"properties"`
}

// loadGeometry streams the network and builds the graph from it.
//
// The file is 9.5 MB of GeoJSON describing 235 000 points, and decoding it
// whole would hold the parsed collection and the graph at the same time. The
// features are decoded one at a time instead, so only the current one and the
// graph under construction are ever live.
func loadGeometry(path string, speeds *SpeedIndex) (*Graph, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("rail: %s: %w (run scripts/fetch-geo.sh)", path, err)
	}
	defer f.Close()

	dec := json.NewDecoder(bufio.NewReaderSize(f, 1<<20))
	if err := seekFeatures(dec); err != nil {
		return nil, fmt.Errorf("rail: %s: %w", path, err)
	}

	b := NewBuilder()
	for dec.More() {
		var ft rfnFeature
		if err := dec.Decode(&ft); err != nil {
			return nil, fmt.Errorf("rail: %s: feature: %w", path, err)
		}
		if ft.Geometry == nil || ft.Properties.Mnemo != inService {
			continue
		}
		pkA, okA := parsePK(ft.Properties.PkDebut)
		pkB, okB := parsePK(ft.Properties.PkFin)
		kmh := speeds.SpeedFor(ft.Properties.CodeLigne, pkA, pkB, okA, okB)

		lines, err := lineStrings(ft.Geometry.Type, ft.Geometry.Coordinates)
		if err != nil {
			return nil, fmt.Errorf("rail: %s: %w", path, err)
		}
		for _, line := range lines {
			prev := int32(-1)
			for _, c := range line {
				if len(c) < 2 {
					continue
				}
				// GeoJSON is [lon, lat].
				id := b.NodeAt(c[1], c[0])
				if prev >= 0 {
					b.Link(prev, id, kmh)
				}
				prev = id
			}
		}
	}

	b.Stitch(stitchToleranceKm)
	return b.Build(), nil
}

// lineStrings normalises a geometry to a list of lines, so LineString and
// MultiLineString are handled the same way downstream.
func lineStrings(kind string, raw json.RawMessage) ([][][]float64, error) {
	switch kind {
	case "LineString":
		var one [][]float64
		if err := json.Unmarshal(raw, &one); err != nil {
			return nil, fmt.Errorf("LineString coordinates: %w", err)
		}
		return [][][]float64{one}, nil
	case "MultiLineString":
		var many [][][]float64
		if err := json.Unmarshal(raw, &many); err != nil {
			return nil, fmt.Errorf("MultiLineString coordinates: %w", err)
		}
		return many, nil
	default:
		// Points and polygons appear in some exports; they carry no track.
		return nil, nil
	}
}

// seekFeatures advances the decoder to just inside the feature collection's
// "features" array, skipping whatever the file carries before it.
func seekFeatures(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return fmt.Errorf("expected a feature collection, got %v", tok)
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return err
		}
		if name, _ := key.(string); name == "features" {
			open, err := dec.Token()
			if err != nil {
				return err
			}
			if d, ok := open.(json.Delim); !ok || d != '[' {
				return fmt.Errorf(`"features" is %v, not an array`, open)
			}
			return nil
		}
		if err := skipValue(dec); err != nil {
			return err
		}
	}
	return errors.New(`no "features" array`)
}

// skipValue consumes one value without decoding it into anything.
func skipValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := tok.(json.Delim)
	if !ok || (d != '{' && d != '[') {
		return nil
	}
	for dec.More() {
		if d == '{' {
			if _, err := dec.Token(); err != nil { // key
				return err
			}
		}
		if err := skipValue(dec); err != nil {
			return err
		}
	}
	_, err = dec.Token() // closing delimiter
	return err
}
