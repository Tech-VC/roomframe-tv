#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"

[[ -r "$RUNTIME_CONFIG" ]] || {
  echo "Configuration runtime introuvable ou illisible: $RUNTIME_CONFIG" >&2
  exit 1
}

# runtime.conf ne contient que des valeurs non secrètes. Les secrets restent
# des fichiers Docker montés sous /run/secrets.
set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
[[ -f "$INSTALL_DIR/compose.yaml" ]] || {
  echo "compose.yaml introuvable dans $INSTALL_DIR" >&2
  exit 1
}

export COMPOSE_DISABLE_ENV_FILE=1
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-roomframe}"

if docker compose version >/dev/null 2>&1; then
  exec docker compose --env-file /dev/null -f "$INSTALL_DIR/compose.yaml" "$@"
fi
if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose --env-file /dev/null -f "$INSTALL_DIR/compose.yaml" "$@"
fi

echo "Docker Compose est introuvable." >&2
exit 1
