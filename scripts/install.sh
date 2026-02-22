#!/usr/bin/env bash
set -euo pipefail

# One-command install:
# - installs Node deps
# - installs ~/.local/bin/t560 launcher
# - launches the onboarding wizard

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "install error: node not found on PATH" >&2
  echo "Install Node.js (recommended: v22+), then re-run." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "install error: npm not found on PATH" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "==> Installing dependencies (npm)"
npm install

chmod +x "$ROOT_DIR/scripts/t560" "$ROOT_DIR/scripts/install_cli.sh"
if [[ -x "$ROOT_DIR/bin/t560.mjs" ]]; then
  chmod +x "$ROOT_DIR/bin/t560.mjs" || true
fi

echo ""
echo "==> Installing t560 command"
bash "$ROOT_DIR/scripts/install_cli.sh" --force

echo ""
echo "==> Starting onboarding wizard"
t560 onboard

