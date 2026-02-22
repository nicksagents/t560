#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
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

T560_CONFIG_DIR="${T560_CONFIG_DIR:-$HOME/.t560}"
mkdir -p "$T560_CONFIG_DIR"

export T560_IMAGE="$IMAGE_NAME"
export T560_CONFIG_DIR
export T560_GATEWAY_PORT="${T560_GATEWAY_PORT:-18789}"
export T560_GATEWAY_BIND="${T560_GATEWAY_BIND:-lan}"

ENV_FILE="$ROOT_DIR/.env"
cat >"$ENV_FILE" <<EOF
T560_IMAGE=$T560_IMAGE
T560_CONFIG_DIR=$T560_CONFIG_DIR
T560_GATEWAY_PORT=$T560_GATEWAY_PORT
T560_GATEWAY_BIND=$T560_GATEWAY_BIND
EOF

echo "==> Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: LAN (0.0.0.0)"
echo "  - Gateway auth: token (recommended) or password"
echo ""
docker compose -f "$COMPOSE_FILE" run --rm t560-cli onboard

echo ""
echo "==> Starting gateway"
docker compose -f "$COMPOSE_FILE" up -d t560-gateway

echo ""
echo "Gateway running."
echo "Config dir: $T560_CONFIG_DIR"
echo "WebChat: http://localhost:$T560_GATEWAY_PORT/"
echo ""
echo "Commands:"
echo "  docker compose -f \"$COMPOSE_FILE\" logs -f t560-gateway"
