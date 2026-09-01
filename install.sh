#!/bin/sh
# traincon — install / update (the same command does both)
#
# Deploys the live SNCF train tracker as a service. No API key is required:
# the schedule, the real-time feed and the rail geometry are all open data.
#
# Usage, as root:
#   curl -fsSL https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
#
# A minimal Alpine has wget but not curl, so there:
#   wget -qO- https://raw.githubusercontent.com/nebuloss/traincon/main/install.sh | sh
#
# With an optional SNCF API key (disruption reasons, station boards):
#   curl -fsSL .../install.sh | SNCF_API_KEY=xxxx sh
#
# Systems: Alpine Linux (OpenRC), Debian/Ubuntu (systemd)
#
# Layout: settings, output helpers, a platform layer holding every
# Alpine/Debian difference, the install steps, and main() at the bottom —
# which reads as the list of things this script does.

set -eu

PATH="/usr/local/bin:$PATH"
export PATH


# ═══ Settings, all overridable from the environment ═══════════════════════════

APP_DIR="${APP_DIR:-/opt/traincon}"
APP_PORT="${APP_PORT:-3000}"
SERVICE_NAME="${SERVICE_NAME:-traincon}"
SERVICE_USER="${SERVICE_USER:-traincon}"
NODE_VERSION="${NODE_VERSION:-22}"
GH_REPO="${GH_REPO:-nebuloss/traincon}"
TARBALL="${TARBALL:-}"              # install this archive instead of a release
VERSION="${VERSION:-}"              # install this tag instead of the newest
SNCF_API_KEY="${SNCF_API_KEY:-}"    # optional
FETCH_GEO="${FETCH_GEO:-1}"         # 0 to skip the 19 MB rail geometry
BOOT_TIMEOUT="${BOOT_TIMEOUT:-180}" # seconds to wait for the first response
QUIET="${QUIET:-0}"                 # 1 to drop the progress dots

# Oldest Node the server runs on; below this a newer one is installed.
NODE_MINIMUM=20

# Replaced wholesale on update. data/ is deliberately absent: it holds the
# cached GTFS, the rail geometry and the last feed snapshot — 24 MB that would
# otherwise be re-downloaded every time.
APP_CONTENTS="dist dist-server scripts fixtures tools"

LOG_FILE="/var/log/${SERVICE_NAME}.log"


# ═══ Output ═══════════════════════════════════════════════════════════════════

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info() { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
fail() { printf "${RED}[x]${NC} %s\n" "$*"; }
die()  { fail "$*"; exit 1; }

# Progress, unless we were asked to keep quiet.
tick()    { [ "$QUIET" = "1" ] || printf '.'; }
endline() { [ "$QUIET" = "1" ] || printf '\n'; }

dump_logs() {
  printf '\n'
  warn "last log lines:"
  service_tail
}


# ═══ Platform ═════════════════════════════════════════════════════════════════
#
# The only place Alpine and Debian differ. Every step below goes through these,
# so supporting another distribution means editing this section and nothing
# else.

detect_platform() {
  if [ -f /etc/alpine-release ]; then
    OS=alpine
  elif [ -f /etc/debian_version ]; then
    OS=debian
  else
    die "unsupported system (needs Alpine or Debian/Ubuntu)"
  fi
}

# Install packages. Errors are reported but not fatal: a package left broken
# elsewhere on the system must not abort an install that needs nothing new.
pkg_install() {
  case "$OS" in
    alpine)
      apk update -q >/dev/null 2>&1 || true
      apk add --no-cache "$@" || warn "apk reported an error"
      ;;
    debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null 2>&1 || true
      apt-get install -y -qq "$@" || warn "apt reported an error"
      ;;
  esac
}

create_system_user() {
  case "$OS" in
    alpine)
      adduser -S -D -H -s /sbin/nologin "$SERVICE_USER" >/dev/null 2>&1 || true
      ;;
    debian)
      useradd --system --no-create-home --shell /usr/sbin/nologin \
        "$SERVICE_USER" >/dev/null 2>&1 || true
      ;;
  esac
}

service_stop() {
  case "$OS" in
    alpine) rc-service "$SERVICE_NAME" stop 2>/dev/null || true ;;
    debian) systemctl stop "$SERVICE_NAME" 2>/dev/null || true ;;
  esac
}

service_running() {
  case "$OS" in
    alpine) rc-service "$SERVICE_NAME" status >/dev/null 2>&1 ;;
    debian) systemctl is-active --quiet "$SERVICE_NAME" ;;
  esac
}

service_tail() {
  case "$OS" in
    alpine) tail -25 "$LOG_FILE" 2>/dev/null || true ;;
    debian) journalctl -u "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null || true ;;
  esac
}

# Printed at the end, so the operator knows where to look next.
service_hints() {
  case "$OS" in
    alpine)
      printf '    logs:    tail -f %s\n' "$LOG_FILE"
      printf '    restart: rc-service %s restart\n' "$SERVICE_NAME"
      ;;
    debian)
      printf '    logs:    journalctl -u %s -f\n' "$SERVICE_NAME"
      printf '    restart: systemctl restart %s\n' "$SERVICE_NAME"
      ;;
  esac
}

service_install() {
  case "$OS" in
    alpine) write_openrc_service ;;
    debian) write_systemd_service ;;
  esac
}

write_openrc_service() {
  info "Installing the OpenRC service"

  # start-stop-daemon opens output_log *after* dropping to command_user, and
  # /var/log is root-owned 0755 — so the file must exist and be writable by
  # that user beforehand, or the service dies before producing any output.
  : > "$LOG_FILE"
  chown "$SERVICE_USER" "$LOG_FILE"
  chmod 640 "$LOG_FILE"

  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run
name="$SERVICE_NAME"
description="Traincon - live SNCF train tracking"
command="$(command -v node)"
command_args="$APP_DIR/dist-server/server/index.js"
command_user="$SERVICE_USER"
directory="$APP_DIR"
pidfile="/run/\$RC_SVCNAME.pid"
output_log="$LOG_FILE"
error_log="$LOG_FILE"

# Supervised, so a crash is a five-second gap rather than an outage.
#
# The systemd unit below has always had Restart=always; this side had nothing,
# and start-stop-daemon does not watch what it starts. The process reached its
# heap ceiling on five separate days and each time stayed down until someone
# noticed and ran the service by hand — which needs a stop first, because OpenRC
# reports a crashed service as already started and refuses to start it again.
#
# respawn_max bounds that: ten restarts inside half an hour is a service that
# cannot start at all, and hammering it will not help.
supervisor="supervise-daemon"
respawn_delay=5
respawn_max=10
respawn_period=1800

depend() { need net; after firewall; }

start_pre() {
  # Runs as root, before privileges are dropped, so the 0600 root-owned
  # .env stays unreadable to the service user itself.
  set -a
  [ -f "$APP_DIR/.env" ] && . "$APP_DIR/.env"
  set +a
  checkpath -d -o "$SERVICE_USER" -m 0755 "$APP_DIR/data"
}
EOF
  chmod +x "/etc/init.d/$SERVICE_NAME"
  rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  rc-service "$SERVICE_NAME" restart >/dev/null 2>&1 || rc-service "$SERVICE_NAME" start
}

write_systemd_service() {
  info "Installing the systemd service"

  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Traincon - live SNCF train tracking
Documentation=https://github.com/$GH_REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) $APP_DIR/dist-server/server/index.js
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


# ═══ Steps ════════════════════════════════════════════════════════════════════

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must be run as root"
  fi
  detect_platform
  info "System detected: $OS"
}

# Which of the tools we need are absent, space-separated — so the caller can
# both test the result and pass it straight to pkg_install.
missing_tools() {
  out=""
  for tool in curl tar unzip; do
    command -v "$tool" >/dev/null 2>&1 || out="$out $tool"
  done
  printf '%s' "$out"
}

ensure_tools() {
  missing="$(missing_tools)"
  if [ -z "$missing" ]; then
    info "Required tools already present"
    return 0
  fi

  info "Installing:$missing"
  pkg_install ca-certificates $missing

  still="$(missing_tools)"
  if [ -n "$still" ]; then
    die "still missing after install:$still"
  fi
}

node_major() {
  node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'
}

node_recent_enough() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node_major)" -ge "$NODE_MINIMUM" ] 2>/dev/null
}

ensure_node() {
  if node_recent_enough; then
    info "Node already present: $(node -v)"
    return 0
  fi

  info "Installing Node ${NODE_VERSION}"
  case "$OS" in
    alpine)
      pkg_install nodejs npm
      ;;
    debian)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1 ||
        warn "NodeSource setup failed, trying the distribution package"
      pkg_install nodejs
      ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    die "Node installation failed"
  fi
  info "Node installed: $(node -v)"
}

# The release tag to install, on stdout.
#
# Not releases/latest/download/: that alias is CDN-cached, and for a few
# minutes after a new tag it still serves the previous asset — which installs
# an older build over a newer one and reports success.
resolve_release_tag() {
  if [ -n "$VERSION" ]; then
    printf '%s' "$VERSION"
    return 0
  fi
  curl -fsSL "https://api.github.com/repos/${GH_REPO}/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -1
}

# Unpack the application into the directory given as $1.
unpack_release() {
  dest="$1"

  if [ -n "$TARBALL" ]; then
    info "Installing from $TARBALL"
    tar -xzf "$TARBALL" -C "$dest"
    return 0
  fi

  tag="$(resolve_release_tag)"
  if [ -z "$tag" ]; then
    die "could not resolve the latest release of $GH_REPO"
  fi
  # Kept so the signal data can be taken from the same release, rather than
  # from whatever happens to be newest by the time that runs.
  RELEASE_TAG="$tag"

  info "Downloading $tag of $GH_REPO"
  url="https://github.com/${GH_REPO}/releases/download/${tag}/traincon.tar.gz"
  curl -fsSL "$url" -o "$dest/app.tar.gz" || die "download failed: $url"
  tar -xzf "$dest/app.tar.gz" -C "$dest"
  rm -f "$dest/app.tar.gz"
}

install_app() {
  # Stop first: replacing files under a running service leaves it half-updated.
  service_stop

  mkdir -p "$APP_DIR"
  tmp="$(mktemp -d)"
  unpack_release "$tmp"

  for dir in $APP_CONTENTS; do
    rm -rf "${APP_DIR:?}/$dir"
  done
  cp -r "$tmp"/. "$APP_DIR"/
  rm -rf "$tmp"
}

install_dependencies() {
  info "Installing dependencies"
  cd "$APP_DIR"
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ||
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ||
    die "npm install failed"
}

ensure_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    return 0
  fi
  info "Creating user $SERVICE_USER"
  create_system_user
}

# The memory this machine actually has, in MB, on stdout.
#
# Inside LXC neither free(1) nor /proc/meminfo reflects the container limit —
# only the cgroup does, so that is consulted first.
memory_limit_mb() {
  for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/.lxc/memory.max \
           /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    [ -r "$f" ] || continue
    v="$(cat "$f" 2>/dev/null)"
    case "$v" in
      max|'')   continue ;;
      *[!0-9]*) continue ;;
    esac
    # An "unlimited" cgroup leaks the host's figure; ignore anything over 1 TB.
    [ "$v" -gt 1099511627776 ] && continue
    printf '%s' $((v / 1024 / 1024))
    return 0
  done

  # Under LXC the cgroup often reads "max" inside the namespace while lxcfs
  # still reports the container's real size in /proc/meminfo — which is how a
  # 512 MB container is detected here.
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || true
  fi
}

# How much heap V8 may use, in MB, on stdout.
#
# --max-old-space-size is a ceiling, and V8 treats it as licence to defer
# collection: given 2 GB on a 512 MB container the process settled at 392 MB
# RSS and was one traffic spike from the OOM killer.
heap_limit() {
  mb="$(memory_limit_mb)"
  case "$mb" in
    ''|*[!0-9]*) echo 512; return 0 ;;
  esac

  # Leave room for everything outside the old space. Not the rail graph: that
  # is plain JS arrays and lives *in* the heap. It is Node's own runtime, the
  # protobuf decode, socket buffers, and the memory the allocator keeps after
  # parsing two 9.5 MB geometry files at boot — measured at ~210 MB of RSS
  # above a 90 MB heap, which is why 55% rather than something higher.
  heap=$((mb * 55 / 100))
  [ "$heap" -lt 192 ]  && heap=192
  [ "$heap" -gt 1024 ] && heap=1024
  echo "$heap"
}

# The key already stored by a previous install, if any.
#
# .env is rewritten wholesale below, so without this an update would silently
# drop a key configured months ago — and the only visible symptom would be the
# delay reasons quietly going blank.
stored_api_key() {
  [ -f "$APP_DIR/.env" ] || return 0
  sed -n 's/^SNCF_API_KEY=\(.*\)$/\1/p' "$APP_DIR/.env" | head -1
}

write_env() {
  heap="$(heap_limit)"
  info "Heap ceiling: ${heap} MB"

  if [ -z "$SNCF_API_KEY" ]; then
    SNCF_API_KEY="$(stored_api_key)"
    if [ -n "$SNCF_API_KEY" ]; then
      info "Keeping the SNCF API key already configured"
    fi
  fi

  # The key, when present, goes in a root-owned file the service reads — not
  # on the command line, where `ps` or /proc/<pid>/environ would show it.
  umask 077
  {
    printf 'PORT=%s\n' "$APP_PORT"
    printf 'NODE_OPTIONS=--max-old-space-size=%s\n' "$heap"
    if [ -n "$SNCF_API_KEY" ]; then
      printf 'SNCF_API_KEY=%s\n' "$SNCF_API_KEY"
    fi
  } > "$APP_DIR/.env"
  chown root:root "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  umask 022

  if [ -n "$SNCF_API_KEY" ]; then
    info "SNCF API key stored in $APP_DIR/.env"
  fi
}

fetch_geometry() {
  if [ "$FETCH_GEO" != "1" ]; then
    warn "skipping rail geometry (FETCH_GEO=0)"
    return 0
  fi
  if [ -f "$APP_DIR/data/geo/rfn.geojson" ]; then
    info "Rail geometry already present"
    return 0
  fi

  info "Downloading rail geometry (~19 MB, once)"
  TRAINCON_TAG="${RELEASE_TAG:-}" sh "$APP_DIR/scripts/fetch-geo.sh" >/dev/null 2>&1 ||
    warn "geometry unavailable: positions will fall back to straight lines"
}

# Signals come from the release and are small, so they are refreshed on every
# install rather than only on the first. Without this an upgrade kept whatever
# an older version had left behind — and for a long time that was nothing at
# all, because nothing here fetched them.
fetch_signals() {
  [ "$FETCH_GEO" = "1" ] || return 0
  mkdir -p "$APP_DIR/data/geo"

  if [ -n "${RELEASE_TAG:-}" ]; then
    url="https://github.com/${GH_REPO}/releases/download/${RELEASE_TAG}/signals.json.gz"
  else
    url="https://github.com/${GH_REPO}/releases/latest/download/signals.json.gz"
  fi

  if curl -fsSL --retry 2 -m 120 "$url" -o "$APP_DIR/data/geo/signals.json.gz" &&
     gunzip -f "$APP_DIR/data/geo/signals.json.gz"; then
    info "Signal positions installed"
  else
    warn "signals unavailable: train spacing will fall back to block lengths"
  fi
}

fix_permissions() {
  # Only data/ needs to be writable: cached GTFS, geometry, feed snapshot.
  mkdir -p "$APP_DIR/data"
  chown -R root:root "$APP_DIR"
  chown -R "$SERVICE_USER" "$APP_DIR/data"
  chmod 600 "$APP_DIR/.env" 2>/dev/null || true
}

responding() {
  curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/api/stats" >/dev/null 2>&1
}

# How many trains the running service reports, on stdout.
tracked_trains() {
  curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/api/stats" 2>/dev/null |
    sed -n 's/.*"total":\([0-9]*\).*/\1/p'
}

wait_ready() {
  # First boot downloads the 4 MB GTFS and parses it, so it is legitimately
  # slower than later starts. Print progress rather than sitting silent, and
  # stop early if the service has died instead of waiting out the timeout.
  info "Starting the service (first boot downloads the timetable, ~1-2 min)"

  i=0
  while [ "$i" -lt "$BOOT_TIMEOUT" ]; do
    if responding; then
      total="$(tracked_trains)"
      endline
      info "Ready — tracking ${total:-0} trains"
      return 0
    fi

    # Only trust a "not running" reading once it has had a moment to start.
    if [ "$i" -gt 5 ] && ! service_running; then
      endline
      fail "the service stopped unexpectedly"
      dump_logs
      return 1
    fi

    i=$((i + 1))
    if [ $((i % 5)) -eq 0 ]; then
      tick
    fi
    sleep 1
  done

  endline
  fail "no response on port $APP_PORT after ${BOOT_TIMEOUT}s"
  dump_logs
  return 1
}

print_summary() {
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\n'
  info "Traincon installed in $APP_DIR"
  info "Web interface: http://${ip:-127.0.0.1}:$APP_PORT"
  if [ -z "$SNCF_API_KEY" ]; then
    warn "no SNCF_API_KEY: disruption reasons unavailable (tracking works regardless)"
  fi
  service_hints
}


# ═══ Run ══════════════════════════════════════════════════════════════════════

main() {
  require_root
  ensure_tools
  ensure_node

  install_app
  install_dependencies

  ensure_user
  write_env
  fetch_geometry
  fetch_signals
  fix_permissions

  service_install

  if wait_ready; then ready=1; else ready=0; fi
  print_summary

  # A non-zero exit matters when this is piped into a provisioning tool.
  [ "$ready" = "1" ]
}

main "$@"
