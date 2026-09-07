package api

import (
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The site's own card, for any page that is not about one train.
const (
	siteTitle = "Tchou tchou train"
	siteDesc  = "Les trains SNCF en temps réel : retards, positions et causes."
)

// mimeTypes are the content types the bundle needs.
//
// Explicit rather than sniffed: the manifest and the icons must arrive with
// their own types or the browser will not treat them as such, and a link-preview
// crawler skips an image sent as octet-stream.
var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".ico":         "image/x-icon",
	".woff2":       "font/woff2",
	".map":         "application/json; charset=utf-8",
}

// card is what a link preview says about a page.
type card struct {
	title string
	desc  string
}

// origin is the absolute origin of a request, for the Open Graph tags.
//
// WhatsApp and the other link-preview crawlers reject a relative og:image, so
// the tags have to name the host the request actually arrived on.
func origin(r *http.Request) string {
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return ""
	}
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return scheme + "://" + host
}

// hhmm formats an epoch second as a Paris wall clock time.
func hhmm(t int64) string {
	return time.Unix(t, 0).In(parisLocation()).Format("15:04")
}

func parisLocation() *time.Location {
	loc, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		return time.UTC
	}
	return loc
}

// delayText words a delay the way the page does.
func delayText(sec int64) string {
	m := sec / 60
	if m >= 60 {
		h := m / 60
		rem := m % 60
		if rem == 0 {
			return fmt.Sprintf("+%d h", h)
		}
		return fmt.Sprintf("+%d h %02d", h, rem)
	}
	return fmt.Sprintf("+%d min", m)
}

// preview builds the card for a page: the site's own, or the train it names.
func (s *Server) preview(urlPath, rawQuery string) card {
	link, ok := TrainFromPath(urlPath)
	if !ok {
		link, ok = TrainFromQuery(rawQuery)
	}
	if !ok {
		return card{siteTitle, siteDesc}
	}
	hits := s.store.Find(link.Train)
	if len(hits) == 0 {
		return card{siteTitle, siteDesc}
	}
	t := hits[0]

	var parts []string
	switch {
	case t.Cancelled:
		parts = append(parts, "Supprimé")
	case t.Delay >= 60:
		parts = append(parts, delayText(t.Delay))
	default:
		parts = append(parts, "À l'heure")
	}
	terminus := t.Calls[len(t.Calls)-1]
	// On the last leg the next stop is the terminus; saying it twice reads
	// like a mistake in a preview that has room for one line.
	if t.Next != nil && t.Next.Name != terminus.Name {
		parts = append(parts, fmt.Sprintf("prochain arrêt %s à %s", t.Next.Name, hhmm(t.Next.Time)))
	}
	parts = append(parts, fmt.Sprintf("arrivée %s à %s", terminus.Name, hhmm(terminus.Time)))

	return card{
		title: fmt.Sprintf("%s %s · %s → %s", t.ServiceLabel, t.Number, t.Origin, t.Destination),
		desc:  strings.Join(parts, " · "),
	}
}

// serveStatic serves the client bundle, always revalidated.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/")
	if rel == "" {
		rel = "index.html"
	}
	file := filepath.Join(s.publicDir, filepath.Clean("/"+rel))
	if !strings.HasPrefix(file, s.publicDir) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	info, err := os.Stat(file)
	if err != nil || info.IsDir() {
		// An unknown path with no extension is a client route: hand back the
		// shell so a reload keeps working.
		if filepath.Ext(rel) != "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		file = filepath.Join(s.publicDir, "index.html")
		if info, err = os.Stat(file); err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}

	ext := filepath.Ext(file)
	contentType := mimeTypes[ext]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	etag := fmt.Sprintf(`W/"%s-%s"`,
		strconv.FormatInt(info.Size(), 36),
		strconv.FormatInt(info.ModTime().UnixMilli(), 36))

	body, err := os.ReadFile(file)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if ext == ".html" {
		host := origin(r)
		c := s.preview(r.URL.Path, r.URL.RawQuery)
		// The page varies by host and by which train it describes, and that
		// description changes as the delay does — so the ETag has to cover all
		// of it, or a crawler gets a 304 with yesterday's card.
		sum := sha1.Sum([]byte(host + "|" + c.title + "|" + c.desc))
		etag = fmt.Sprintf(`W/"%s-%s-%s"`,
			strconv.FormatInt(info.Size(), 36),
			strconv.FormatInt(info.ModTime().UnixMilli(), 36),
			base64.RawURLEncoding.EncodeToString(sum[:])[:12])

		page := string(body)
		page = strings.ReplaceAll(page, "%OG_TITLE%", html.EscapeString(c.title))
		page = strings.ReplaceAll(page, "%OG_DESC%", html.EscapeString(c.desc))
		page = strings.ReplaceAll(page, "%OG_URL%", html.EscapeString(host+r.URL.Path))
		page = strings.ReplaceAll(page, "%ORIGIN%", host)
		body = []byte(page)
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}
