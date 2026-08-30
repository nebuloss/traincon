#!/usr/bin/env bash
# French rail network geometry + line speeds, from SNCF Réseau open data.
# Keyless. ~19 MB total. Re-run occasionally; the network changes slowly.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/data/geo"
B=https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets
mkdir -p "$DIR"
echo "→ formes-des-lignes-du-rfn (géométrie des lignes)"
curl -fL --retry 2 -m 300 "$B/formes-des-lignes-du-rfn/exports/geojson" -o "$DIR/rfn.geojson"
echo "→ vitesse-maximale-nominale-sur-ligne (vitesses)"
curl -fL --retry 2 -m 300 "$B/vitesse-maximale-nominale-sur-ligne/exports/json" -o "$DIR/vmax.json"
echo "→ mode-de-cantonnement-des-lignes (espacement des trains)"
curl -fL --retry 2 -m 300 "$B/mode-de-cantonnement-des-lignes/exports/json" -o "$DIR/cantonnement.json"
echo "OK : $(du -sh "$DIR" | cut -f1) dans $DIR"
