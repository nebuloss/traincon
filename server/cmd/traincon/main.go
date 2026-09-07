// Command traincon serves the live SNCF train tracker.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"traincon/internal/api"
	"traincon/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	root := os.Getenv("TRAINCON_ROOT")
	if root == "" {
		root = "."
	}
	dataDir := filepath.Join(root, "data")
	publicDir := os.Getenv("PUBLIC_DIR")
	if publicDir == "" {
		publicDir = filepath.Join(root, "dist")
	}
	port := 3000
	if v, err := strconv.Atoi(os.Getenv("PORT")); err == nil && v > 0 {
		port = v
	}

	slog.Info("loading SNCF static GTFS…")
	st := store.New(dataDir)
	if err := st.Start(ctx); err != nil {
		slog.Error("could not start", "err", err)
		os.Exit(1)
	}
	defer st.Stop()

	s := st.Stats()
	slog.Info("ready", "trains", s.Total, "feedAgeSec", s.AgeSec, "stations", len(st.Stations().Stations))

	srv := api.New(st, publicDir)
	if err := srv.Listen(port); err != nil {
		slog.Error("could not listen", "port", port, "err", err)
		os.Exit(1)
	}
	slog.Info("serving", "url", "http://localhost:"+strconv.Itoa(port))

	<-ctx.Done()
	slog.Info("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Close(shutdown); err != nil {
		slog.Warn("shutdown", "err", err)
	}
}
