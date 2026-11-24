#!/usr/bin/env bash
# Run this ON the mini PC, from an administrator (sudo-capable) account,
# after copying this repo's contents there (e.g. scp/rsync this whole
# memomind-muse-bridge/ directory to the mini PC first).
#
# Does NOT: fetch the Muse SDK token, run the musegadget installer, pair the
# gadget, set up Tailscale, or fill in secrets - those are the operator's manual
# steps (see README.md).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/memomind-muse-bridge
ENV_FILE=/etc/memomind-muse-bridge.env
STATE_DIR=/var/lib/memomind-muse-bridge

if ! id -u musebridge >/dev/null 2>&1; then
  echo "Creating the musebridge account (no sudo access)..."
  sudo adduser --disabled-password --gecos "" musebridge
fi
if sudo -l -U musebridge 2>/dev/null | grep -qi "may run"; then
  echo "REFUSING to continue: musebridge appears to have sudo access. Fix this first." >&2
  exit 1
fi

echo "Installing application files to $APP_DIR ..."
sudo install -d -o root -g root -m 0755 "$APP_DIR"
sudo rsync -a --delete "$REPO_DIR/bridge" "$REPO_DIR/requirements.txt" "$APP_DIR/"
sudo chown -R root:root "$APP_DIR"

echo "Creating the venv (stdlib-only; requirements.txt is intentionally empty) ..."
sudo python3 -m venv "$APP_DIR/.venv"
sudo "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

echo "Preparing state directories owned by musebridge ..."
sudo install -d -o musebridge -g musebridge -m 0750 "$STATE_DIR"
sudo install -d -o musebridge -g musebridge -m 0750 "$STATE_DIR/replies"

if [ ! -f "$ENV_FILE" ]; then
  echo "Creating $ENV_FILE from the example template - FILL IN THE SECRETS before starting the service."
  sudo install -o root -g root -m 0600 "$REPO_DIR/deploy/memomind-muse-bridge.env.example" "$ENV_FILE"
else
  echo "$ENV_FILE already exists, leaving it as-is."
fi

echo "Installing the systemd unit ..."
sudo install -o root -g root -m 0644 "$REPO_DIR/systemd/memomind-muse-bridge.service" /etc/systemd/system/memomind-muse-bridge.service
sudo systemctl daemon-reload

cat <<'EOF'

Deploy complete. Before starting the service:
  1. Edit /etc/memomind-muse-bridge.env and fill in every blank value
     (BRIDGE_BIND_HOST, WINDOWS_BACKEND_URL, MUSE_SESSION_ID,
     BRIDGE_INBOUND_SECRET, BACKEND_REPLY_SECRET). Generate secrets with:
       openssl rand -hex 32
  2. Confirm musegadget is already installed and paired (see README.md) -
     the service Requires=musegadget.service and will not start without it.
  3. Then:
       sudo systemctl enable --now memomind-muse-bridge
       sudo systemctl status memomind-muse-bridge --no-pager
       sudo journalctl -u memomind-muse-bridge -n 100 --no-pager
EOF
