// Package gtfs loads the SNCF static schedule: the tables that turn a feed's
// opaque identifiers into station names, coordinates and service markers.
package gtfs

// Family groups rolling stock by what it is, which is what decides how a train
// is drawn, how fast it is allowed to go, and whether it may use a high-speed
// line.
type Family string

// The families the rest of the server knows about.
const (
	FamilyTGV   Family = "tgv"
	FamilyIC    Family = "ic"
	FamilyTER   Family = "ter"
	FamilyOther Family = "other"
)

// ServiceMeta is how a service presents itself: the name a passenger would use,
// and the family it belongs to.
type ServiceMeta struct {
	Label  string
	Family Family
}

// serviceLabels maps the marker embedded in a static trip_id — the "OUI" in
// "...F:OUI:FR:Line::..." — to what that service is called.
var serviceLabels = map[string]ServiceMeta{
	"OUI": {"TGV inOUI", FamilyTGV},
	"OGO": {"OUIGO", FamilyTGV},
	"LYR": {"TGV Lyria", FamilyTGV},
	"ICE": {"ICE", FamilyTGV},
	"TT":  {"TGV", FamilyTGV},
	"IC":  {"Intercités", FamilyIC},
	"ICN": {"Intercités de Nuit", FamilyIC},
	"TER": {"TER", FamilyTER},
	"TRN": {"Train", FamilyOther},
	"NAV": {"Navette", FamilyOther},
}

// Service describes a service marker. An unknown marker keeps its own code as
// the label rather than being hidden: a new one appearing in the feed should be
// visible, not silently relabelled "Train".
func Service(code string) ServiceMeta {
	if m, ok := serviceLabels[code]; ok {
		return m
	}
	if code == "" {
		return ServiceMeta{Label: "Train", Family: FamilyOther}
	}
	return ServiceMeta{Label: code, Family: FamilyOther}
}
