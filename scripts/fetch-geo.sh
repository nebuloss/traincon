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
# Les signaux sont publiés dans le dépôt : c'est un fichier dérivé
# d'OpenStreetMap via carto.tchoo.net, figé une fois pour toutes. Le
# télécharger ne coûte rien à leur serveur de tuiles, contrairement à le
# reconstruire à chaque installation. Voir data/geo/README.md.
echo "→ signalisation (116 818 signaux, 1,2 Mo)"
SIG=https://raw.githubusercontent.com/nebuloss/traincon/main/data/geo/signals.json.gz
if curl -fL --retry 2 -m 120 "$SIG" -o "$DIR/signals.json.gz"; then
  gunzip -f "$DIR/signals.json.gz"
else
  echo "  signalisation indisponible : l'espacement retombera sur le mode de cantonnement"
fi
echo "OK : $(du -sh "$DIR" | cut -f1) dans $DIR"
