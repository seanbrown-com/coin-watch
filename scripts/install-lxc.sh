#!/usr/bin/env bash
set -Eeuo pipefail

# First-time install for Coin Watch inside a Debian/Ubuntu LXC.
#
# Run as root inside the container:
#   REPO_URL=https://github.com/seanbrown-com/coin-watch.git ./scripts/install-lxc.sh
#
# Optional overrides:
#   APP_DIR=/opt/coin-watch SERVICE_NAME=coin-watch PORT=8002 BRANCH=main ./scripts/install-lxc.sh

REPO_URL="${REPO_URL:-https://github.com/seanbrown-com/coin-watch.git}"
APP_DIR="${APP_DIR:-/opt/coin-watch}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
SERVICE_NAME="${SERVICE_NAME:-coin-watch}"
SERVICE_USER="${SERVICE_USER:-coin-watch}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8002}"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nInstall failed: %s\n' "$*" >&2
  exit 1
}

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    fail "Run this script as root inside the LXC."
  fi
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

install_packages() {
  log "Installing required packages"
  apt-get update
  apt-get install -y ca-certificates curl git

  if ! command -v node >/dev/null 2>&1; then
    log "Installing Node.js from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
}

create_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating service user $SERVICE_USER"
    useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

create_data_dir() {
  log "Preparing data directory $DATA_DIR"
  mkdir -p "$DATA_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 750 "$DATA_DIR"
}

checkout_app() {
  log "Installing app into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"

  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch --prune origin
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  elif [[ -e "$APP_DIR" ]]; then
    fail "$APP_DIR exists but is not a git checkout."
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
}

install_dependencies() {
  log "Installing app dependencies"
  if [[ -f "$APP_DIR/package-lock.json" ]]; then
    sudo -u "$SERVICE_USER" npm --prefix "$APP_DIR" ci --omit=dev
  else
    sudo -u "$SERVICE_USER" npm --prefix "$APP_DIR" install --omit=dev
  fi

  node --check "$APP_DIR/server.js"
}

write_service() {
  log "Writing systemd service"
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=Coin Watch miner dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
Environment=DATA_DIR=${DATA_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

start_service() {
  log "Starting $SERVICE_NAME on port $PORT"
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --lines=25 status "$SERVICE_NAME"
}

need_root
install_packages
need_command git
need_command node
need_command npm
need_command systemctl
create_user
checkout_app
create_data_dir
install_dependencies
write_service
start_service

log "Install complete"
printf 'Coin Watch should be available inside the LXC at http://127.0.0.1:%s\n' "$PORT"
