#!/usr/bin/env bash
# Preflight check: reports what's missing before you try to run backend/ or
# bridge/, without changing anything. Safe to run repeatedly.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ok=0
warn() { echo "  [warn] $1"; }
pass() { echo "  [ ok ] $1"; }
fail() { echo "  [fail] $1"; ok=1; }

echo "backend/ (Node)"
if command -v node >/dev/null 2>&1; then
  v="$(node -v)"
  major="${v#v}"; major="${major%%.*}"
  if [ "$major" -ge 18 ] 2>/dev/null; then pass "node $v"; else warn "node $v (need >=18)"; fi
else
  fail "node not found on PATH"
fi
[ -d "$ROOT/backend/node_modules" ] && pass "backend/node_modules present" || warn "backend/node_modules missing - run: cd backend && npm install"
if [ -f "$ROOT/backend/.env" ]; then
  pass "backend/.env present"
else
  warn "backend/.env missing - copy backend/.env.example and fill it in"
fi
if [ -x "$ROOT/backend/whisper/bin/Release/whisper-server.exe" ] || [ -f "$ROOT/whisper/bin/Release/whisper-server.exe" ]; then
  pass "whisper.cpp server binary found"
else
  warn "whisper.cpp server binary not found (fine if STT_PROVIDER=mock in .env)"
fi

echo "bridge/ (Python, optional unless you're using the Muse route)"
if command -v python3 >/dev/null 2>&1; then
  pass "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  warn "python3 not found on PATH (only needed to run the bridge)"
fi
if command -v musegadget >/dev/null 2>&1; then
  pass "musegadget on PATH"
else
  warn "musegadget not found on PATH (only needed to actually run the bridge, see bridge/README.md)"
fi
if [ -f "/etc/memomind-muse-bridge.env" ]; then
  pass "/etc/memomind-muse-bridge.env present"
else
  warn "/etc/memomind-muse-bridge.env missing - see bridge/README.md setup checklist"
fi

echo
if [ "$ok" -eq 0 ]; then
  echo "No hard failures. Review any [warn] lines above for what's still needed."
else
  echo "One or more hard failures above - fix those first."
fi
exit "$ok"
