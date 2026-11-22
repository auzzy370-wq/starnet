#!/usr/bin/env bash
# Vultron station — startup script for an Enzonic Cloud server (free tier: 2 GB RAM / 200% CPU / 10 GB SSD).
#
#   Panel -> Startup command:   bash deploy/enzonic/start.sh
#
# Enzonic hands an app a port in $SERVER_PORT and keeps the server's home directory across restarts. Everything
# the station writes — workspace, chats, saves, transcripts, spend ledger — lives in $HOME/vultron-data, so a
# reinstall, a git pull or a restart never touches it. The site password is generated once into that directory
# and reused, so restarting does not lock you out of your own station.
#
# No Docker: an Enzonic app is one persistent process with a real filesystem, which is all the station needs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DATA="${VULTRON_DATA_DIR:-${HOME:-/home/container}/vultron-data}"
mkdir -p "$DATA/workspaces"

PASS_FILE="$DATA/station-password"
if [ ! -s "$PASS_FILE" ]; then
	node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))' >"$PASS_FILE"
	chmod 600 "$PASS_FILE"
fi

export HOME="$DATA"
export VULTRON_WORKSPACES="$DATA/workspaces"
export PORT="${SERVER_PORT:-${PORT:-8080}}"
export VULTRON_SITE_USER="${VULTRON_SITE_USER:-vultron}"
export VULTRON_SITE_PASSWORD="$(cat "$PASS_FILE")"
export NODE_ENV=production

# node-pty is the terminal. It ships prebuilds, so no compiler is needed — but install scripts must be skipped
# (the voice stack's onnxruntime-node fetch 404s on Linux and would fail the whole install) and node-pty then
# rebuilt on its own. Skipping the rebuild leaves the terminal dead while everything else looks fine.
if [ ! -f node_modules/.package-lock.json ]; then
	echo "[enzonic] installing dependencies — first boot takes about a minute"
	npm ci --ignore-scripts --no-audit --no-fund
	npm rebuild node-pty --no-audit --no-fund
fi

echo "[enzonic] data      $DATA"
echo "[enzonic] password  $PASS_FILE   (read it in the panel file manager; user is $VULTRON_SITE_USER)"
echo "[enzonic] port      $PORT"
exec node scripts/station-serve.js
