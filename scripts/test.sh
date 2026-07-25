#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

"$ROOT/scripts/check.sh"

NODE_BIN="${ROOMFRAME_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
[[ -x "$NODE_BIN" ]] || {
  echo "Node.js 22 ou plus récent est requis." >&2
  exit 1
}
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! -d "$ROOT/services/api/node_modules" ]]; then
  command -v npm >/dev/null 2>&1 || {
    echo "npm est requis pour installer les dépendances de test." >&2
    exit 1
  }
  (
    cd "$ROOT/services/api"
    npm ci
  )
fi

test_container=""
cleanup() {
  if [[ -n "$test_container" ]]; then
    docker stop "$test_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${ROOMFRAME_TEST_DB_HOST:-}" ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "Docker est requis pour lancer PostgreSQL de test." >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Le démon Docker ne répond pas." >&2
    exit 1
  }
  test_container="roomframe-test-postgres-$$"
  docker run --rm -d \
    --name "$test_container" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_DB=roomframe_test \
    -e POSTGRES_USER=roomframe \
    -p 127.0.0.1::5432 \
    --health-cmd='pg_isready -U roomframe -d roomframe_test' \
    --health-interval=1s \
    --health-timeout=2s \
    --health-retries=30 \
    postgres:17-alpine >/dev/null
  for _ in $(seq 1 40); do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$test_container")"
    [[ "$state" == "healthy" ]] && break
    sleep 1
  done
  [[ "${state:-}" == "healthy" ]] || {
    echo "PostgreSQL de test n'est pas devenu sain." >&2
    exit 1
  }
  published="$(docker port "$test_container" 5432/tcp | head -n 1)"
  export ROOMFRAME_TEST_DB_HOST=127.0.0.1
  export ROOMFRAME_TEST_DB_PORT="${published##*:}"
  export ROOMFRAME_TEST_DB_NAME=roomframe_test
  export ROOMFRAME_TEST_DB_USER=roomframe
  export ROOMFRAME_TEST_DB_PASSWORD=""
fi

"$NODE_BIN" --test prototype/admin/*.test.mjs prototype/tv/*.test.mjs
(
  cd services/api
  "$NODE_BIN" scripts/check-syntax.mjs
  "$NODE_BIN" --test --test-concurrency=1 test/*.test.mjs
)

printf '%s\n' "Tests RoomFrame réussis."
