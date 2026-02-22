#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to install t560. Please install Node 20+ and retry."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install t560. Please install npm and retry."
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is required before starting t560."
  echo "Install it from: https://tailscale.com/download"
  exit 1
fi

TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [[ -z "${TAILSCALE_IP}" ]]; then
  echo "Tailscale is installed but not connected."
  echo "Run: sudo tailscale up"
  exit 1
fi

echo "[t560] Tailscale detected at ${TAILSCALE_IP}"

echo "[t560] Installing dependencies..."
npm install

echo "[t560] Building CLI..."
npm run build

echo "[t560] Linking global command..."
npm link

NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
NPM_LINKED_T560=""
if [[ -n "${NPM_PREFIX}" && -e "${NPM_PREFIX}/bin/t560" ]]; then
  NPM_LINKED_T560="${NPM_PREFIX}/bin/t560"
fi

if [[ -z "${NPM_LINKED_T560}" ]]; then
  COMMAND_T560="$(command -v t560 || true)"
  if [[ -n "${COMMAND_T560}" ]]; then
    RESOLVED_T560="$(readlink -f "${COMMAND_T560}" 2>/dev/null || true)"
    NPM_LINKED_T560="${RESOLVED_T560:-${COMMAND_T560}}"
  fi
fi

if [[ -n "${NPM_LINKED_T560}" && "${NPM_LINKED_T560}" != "${HOME}/.local/bin/t560" ]]; then
  mkdir -p "${HOME}/.local/bin"
  ln -snf "${NPM_LINKED_T560}" "${HOME}/.local/bin/t560"
fi

echo "[t560] If your shell still reports an old t560 path, run: hash -r"

echo "[t560] Starting agent..."
exec t560 gateway
