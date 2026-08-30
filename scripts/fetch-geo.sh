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
# Les signaux voyagent avec la release : fichier dérivé d'OpenStreetMap via
# carto.tchoo.net, réduit à ce que le serveur lit réellement (24 673 signaux
# d'arrêt + les noms de voie repliés par cellule). Le télécharger ne coûte
# rien à leur serveur de tuiles, contrairement à le reconstruire à chaque
# installation. Voir data/geo/README.md.
echo "→ signalisation (24 673 signaux d'arrêt, 160 ko)"
REPO=nebuloss/traincon
if [ -n "${TRAINCON_TAG:-}" ]; then
  SIG="https://github.com/$REPO/releases/download/$TRAINCON_TAG/signals.json.gz"
else
  SIG="https://github.com/$REPO/releases/latest/download/signals.json.gz"
fi
if curl -fL --retry 2 -m 120 "$SIG" -o "$DIR/signals.json.gz" ||
   curl -fL --retry 2 -m 120 "https://raw.githubusercontent.com/$REPO/main/data/geo/signals.json.gz" -o "$DIR/signals.json.gz"; then
  gunzip -f "$DIR/signals.json.gz"
else
  echo "  signalisation indisponible : l'espacement retombera sur le mode de cantonnement"
fi

echo "OK : $(du -sh "$DIR" | cut -f1) dans $DIR"
