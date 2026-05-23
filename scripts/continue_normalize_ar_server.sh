#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_SCRIPT="${CONTINUE_NORMALIZE_PY:-$SCRIPT_DIR/continue_normalize_ar_server.py}"

if [ ! -x "$PY_SCRIPT" ]; then
  chmod +x "$PY_SCRIPT" 2>/dev/null || true
fi

exec python3 "$PY_SCRIPT"
