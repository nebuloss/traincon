package api

import (
	"net/url"
	"regexp"
	"strings"
)

// trainNumber is what counts as a train number: short and alphanumeric.
// Anything else is not a link to a train.
var trainNumber = regexp.MustCompile(`^[A-Za-z0-9]{1,8}$`)

// Link is a deep link to one train.
type Link struct {
	Train string
	Tab   string
}

// TrainFromPath reads /train/8540, /train/8540/carte or /t/8540.
func TrainFromPath(pathname string) (Link, bool) {
	parts := strings.FieldsFunc(pathname, func(r rune) bool { return r == '/' })
	if len(parts) < 2 || (parts[0] != "train" && parts[0] != "t") {
		return Link{}, false
	}
	if !trainNumber.MatchString(parts[1]) {
		return Link{}, false
	}
	link := Link{Train: strings.ToUpper(parts[1])}
	if len(parts) > 2 {
		link.Tab = parts[2]
	}
	return link, true
}

// TrainFromQuery reads ?train=8540&tab=carte.
//
// The hash forms live in the client router alone: a fragment is never sent to
// the server, so it cannot see them.
func TrainFromQuery(rawQuery string) (Link, bool) {
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return Link{}, false
	}
	n := q.Get("train")
	if n == "" {
		n = q.Get("t")
	}
	if n == "" || !trainNumber.MatchString(n) {
		return Link{}, false
	}
	return Link{Train: strings.ToUpper(n), Tab: q.Get("tab")}, true
}
