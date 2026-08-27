#!/bin/sh
# traincon — install / update (the same command does both)
#
# Deploys the live SNCF train tracker as a service. No API key is required:
# the schedule, the real-time feed and the rail geometry are all open data.
#
# Usage, as root:
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
#
# With an optional SNCF API key (disruption reasons, station boards):
#   curl -fsSL .../install.sh | SNCF_API_KEY=xxxx sh
#
# Systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)

set -eu

PATH="/usr/local/bin:$PATH"
export PATH

# ── Settings, all overridable from the environment ───────────────────────────
APP_DIR="${APP_DIR:-/opt/traincon}"
APP_PORT="${APP_PORT:-3000}"
SERVICE_NAME="${SERVICE_NAME:-traincon}"
SERVICE_USER="${SERVICE_USER:-traincon}"
NODE_VERSION="${NODE_VERSION:-22}"
GH_REPO="${GH_REPO:-nebuloss/traincon}"
TARBALL="${TARBALL:-}"              # install this archive instead of a release
SNCF_API_KEY="${SNCF_API_KEY:-}"    # optional
FETCH_GEO="${FETCH_GEO:-1}"         # 0 to skip the 19 MB rail geometry

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[x]${NC} %s\n" "$*"; exit 1; }

# ── Steps ────────────────────────────────────────────────────────────────────

check_host() {
  [ "$(id -u)" -eq 0 ] || error "a lancer en root"

  if   [ -f /etc/alpine-release ]; then OS=alpine
  elif [ -f /etc/debian_version ]; then OS=debian
  else error "systeme non supporte"; fi
  info "Systeme detecte : $OS"

  # The static GTFS is a zip and the geometry is fetched over HTTPS.
  for c in curl unzip; do
    command -v "$c" >/dev/null 2>&1 || NEED_PKGS="${NEED_PKGS:-} $c"
  done
}

install_deps() {
  case "$OS" in
    alpine) apk update -q
            apk add --no-cache curl ca-certificates tar unzip >/dev/null ;;
    debian) export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq curl ca-certificates tar unzip >/dev/null ;;
  esac

  if command -v node >/dev/null 2>&1 &&
     [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 20 ] 2>/dev/null; then
    info "Node deja present : $(node -v)"
    return
  fi

  info "Installation de Node ${NODE_VERSION}"
  case "$OS" in
    alpine) apk add --no-cache nodejs npm >/dev/null ;;
    debian) curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
            apt-get install -y -qq nodejs >/dev/null ;;
  esac
  command -v node >/dev/null 2>&1 || error "installation de Node echouee"
}

fetch_app() {
  # Stop first: replacing files under a running service leaves it half-updated.
  if [ "$OS" = alpine ]; then
    rc-service "$SERVICE_NAME" stop 2>/dev/null || true
  else
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  fi

  mkdir -p "$APP_DIR"
  tmp="$(mktemp -d)"

  if [ -n "$TARBALL" ]; then
    info "Installation depuis $TARBALL"
    tar -xzf "$TARBALL" -C "$tmp"
  else
    info "Telechargement de la derniere version de $GH_REPO"
    url="https://github.com/${GH_REPO}/releases/latest/download/traincon.tar.gz"
    curl -fsSL "$url" -o "$tmp/app.tar.gz" || error "telechargement impossible : $url"
    tar -xzf "$tmp/app.tar.gz" -C "$tmp"
  fi

  # Keep data/ across updates: it holds the cached GTFS, the rail geometry and
  # the last-known feed snapshot. Re-downloading them on every update would be
  # 24 MB for nothing.
  rm -rf "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/scripts" "$APP_DIR/fixtures"
  cp -r "$tmp"/. "$APP_DIR"/
  rm -rf "$tmp"

  cd "$APP_DIR"
  info "Installation des dependances"
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ||
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ||
    error "npm install echoue"
}

fetch_geo() {
  [ "$FETCH_GEO" = "1" ] || { warn "geometrie ferroviaire ignoree (FETCH_GEO=0)"; return; }
  if [ -f "$APP_DIR/data/geo/rfn.geojson" ]; then
    info "Geometrie ferroviaire deja presente"
    return
  fi
  info "Telechargement de la geometrie ferroviaire (~19 Mo, une fois)"
  sh "$APP_DIR/scripts/fetch-geo.sh" >/dev/null 2>&1 ||
    warn "geometrie indisponible : les positions retomberont sur des lignes droites"
}

make_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then return; fi
  info "Creation de l'utilisateur $SERVICE_USER"
  case "$OS" in
    alpine) adduser -S -D -H -s /sbin/nologin "$SERVICE_USER" >/dev/null 2>&1 || true ;;
    debian) useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" >/dev/null 2>&1 || true ;;
  esac
}

write_env() {
  # The key, when present, goes in a root-owned file the service reads —
  # not on the command line, where `ps` or /proc/<pid>/environ would show it.
  umask 077
  {
    printf 'PORT=%s\n' "$APP_PORT"
    printf 'NODE_OPTIONS=--max-old-space-size=2048\n'
    [ -n "$SNCF_API_KEY" ] && printf 'SNCF_API_KEY=%s\n' "$SNCF_API_KEY"
  } > "$APP_DIR/.env"
  chown root:root "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  [ -n "$SNCF_API_KEY" ] && info "Cle API SNCF enregistree dans $APP_DIR/.env"
  umask 022
}

fix_perms() {
  # Only data/ needs to be writable: cached GTFS, geometry, feed snapshot.
  mkdir -p "$APP_DIR/data"
  chown -R root:root "$APP_DIR"
  chown -R "$SERVICE_USER" "$APP_DIR/data"
  chmod 600 "$APP_DIR/.env" 2>/dev/null || true
}

install_service_openrc() {
  info "Installation du service OpenRC"
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run
name="$SERVICE_NAME"
description="Traincon — suivi des trains SNCF en temps reel"
command="$(command -v node)"
command_args="$APP_DIR/src/server.js"
command_user="$SERVICE_USER"
command_background=true
directory="$APP_DIR"
pidfile="/run/\$RC_SVCNAME.pid"
output_log="/var/log/$SERVICE_NAME.log"
error_log="/var/log/$SERVICE_NAME.log"

depend() { need net; after firewall; }

start_pre() {
  set -a
  [ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env"
  set +a
}
EOF
  chmod +x "/etc/init.d/$SERVICE_NAME"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || rc-service "$SERVICE_NAME" start
}

install_service_systemd() {
  info "Installation du service systemd"
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Traincon — suivi des trains SNCF en temps reel
Documentation=https://github.com/$GH_REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) $APP_DIR/src/server.js
Restart=always
RestartSec=5

# The service only ever needs to write to data/.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  systemctl restart "$SERVICE_NAME"
}

wait_ready() {
  info "Demarrage"
  i=0
  while [ "$i" -lt 90 ]; do
    if curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/api/stats" >/dev/null 2>&1; then
      total=$(curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/api/stats" 2>/dev/null |
              sed -n 's/.*"total":\([0-9]*\).*/\1/p')
      info "Pret — ${total:-0} trains suivis"
      return 0
    fi
    i=$((i + 1)); sleep 1
  done
  warn "le service n'a pas repondu en 90 s"
  case "$OS" in
    alpine) tail -20 "/var/log/$SERVICE_NAME.log" 2>/dev/null || true ;;
    debian) journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true ;;
  esac
  return 1
}

# ── Run ──────────────────────────────────────────────────────────────────────
check_host
install_deps
fetch_app
make_user
write_env
fetch_geo
fix_perms
case "$OS" in
  alpine) install_service_openrc ;;
  debian) install_service_systemd ;;
esac
wait_ready || true

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
printf '\n'
info "Traincon installe dans $APP_DIR"
info "Interface : http://${ip:-127.0.0.1}:$APP_PORT"
[ -z "$SNCF_API_KEY" ] &&
  warn "sans SNCF_API_KEY : pas de motifs de perturbation (le suivi fonctionne quand meme)"
case "$OS" in
  alpine) printf '    logs : tail -f /var/log/%s.log\n' "$SERVICE_NAME" ;;
  debian) printf '    logs : journalctl -u %s -f\n' "$SERVICE_NAME" ;;
esac
