#!/usr/bin/env bash
# Vultron station — one-line entry point for an Enzonic Cloud app.
#
#   Panel -> Startup command:   bash deploy/enzonic/start.sh
#
# All the work is in boot.js (see its header): the egg launches a JS file with `node`, so the real
# implementation lives there and this stays a wrapper for when you are in the console instead of the panel.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/boot.js"
