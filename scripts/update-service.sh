#!/usr/bin/env bash
set -Eeuo pipefail

# Update a Coin Watch deployment on an LXC host/container.
#
# Defaults assume:
#   - App checkout: /opt/coin-watch
#   - systemd service: coin-watch.service
#   - Branch: main
#
# Override when needed:
#   APP_DIR=/srv/coin-watch SERVICE_NAME=coin-watch BRANCH=main ./scripts/update-service.sh

APP_DIR="${APP_DIR:-/opt/coin-watch}"
DATA_DIR="${DATA_DIR:-${APP_DIR}/data}"
SERVICE_NAME="${SERVICE_NAME:-coin-watch}"
SERVICE_USER="${SERVICE_USER:-coin-watch}"
BRANCH="${BRANCH:-main}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nUpdate failed: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

need_command git
need_command systemctl
need_command "$NODE_BIN"
need_command "$NPM_BIN"

if [[ ! -d "$APP_DIR/.git" ]]; then
  fail "$APP_DIR is not a git checkout. Set APP_DIR to the deployed repo path."
fi

cd "$APP_DIR"

log "Checking working tree"
if [[ -n "$(git status --porcelain)" ]]; then
  fail "Working tree has local changes in $APP_DIR. Commit, stash, or remove them before updating."
fi

log "Fetching latest code"
git fetch --prune origin

log "Updating $BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

log "Installing production dependencies"
if [[ -f package-lock.json ]]; then
  "$NPM_BIN" ci --omit=dev
else
  "$NPM_BIN" install --omit=dev
fi

log "Checking server syntax"
"$NODE_BIN" --check server.js

log "Ensuring shared data directory is writable"
sudo mkdir -p "$DATA_DIR"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
sudo chmod 750 "$DATA_DIR"

log "Restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

log "Service status"
systemctl --no-pager --lines=20 status "$SERVICE_NAME"

log "Coin Watch update complete"
