#!/usr/bin/env bash
set -euo pipefail

# Secure Docker setup:
# - Stores config + secrets in a named Docker volume (not a host-mounted folder).
# - The host-side `t560` client never reads OPENAI_API_KEY from disk.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.secure.yml"
IMAGE_NAME="${T560_IMAGE:-t560:local}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

export T560_IMAGE="$IMAGE_NAME"
export T560_GATEWAY_PORT="${T560_GATEWAY_PORT:-18789}"
export T560_GATEWAY_BIND="${T560_GATEWAY_BIND:-lan}"

echo "==> Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
docker compose -f "$COMPOSE_FILE" run --rm t560-cli onboard

echo ""
echo "==> Starting gateway"
docker compose -f "$COMPOSE_FILE" up -d t560-gateway

echo ""
echo "Gateway running."
echo "WebChat: http://localhost:$T560_GATEWAY_PORT/"
echo ""
echo "Commands:"
echo "  docker compose -f \"$COMPOSE_FILE\" logs -f t560-gateway"
echo "  docker compose -f \"$COMPOSE_FILE\" exec t560-gateway node src/cli.js doctor"

