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
NODE_DIRECTORY="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIRECTORY:$PATH"

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
verify_container=""
test_secret_directory=""
test_temporary_base=""
certificate_test_directory=""
cleanup() {
  if [[ -n "$verify_container" ]]; then
    docker stop "$verify_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$test_container" ]]; then
    docker stop "$test_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$test_secret_directory" && -d "$test_secret_directory" ]]; then
    find "$test_secret_directory" -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$test_secret_directory" 2>/dev/null || true
  fi
  if [[ -n "$test_temporary_base" && -d "$test_temporary_base" ]]; then
    rmdir "$test_temporary_base" 2>/dev/null || true
  fi
  if [[ -n "$certificate_test_directory" && -d "$certificate_test_directory" ]]; then
    find "$certificate_test_directory" -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$certificate_test_directory" 2>/dev/null || true
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
  test_temporary_base="$ROOT/.test-runtime"
  mkdir -p "$test_temporary_base"
  test_secret_directory="$(mktemp -d "$test_temporary_base/postgres-secrets.XXXXXX")"
  printf '%096d\n' 0 >"$test_secret_directory/postgres_password"
  printf '%096d\n' 1 >"$test_secret_directory/postgres_migrator_password"
  printf '%096d\n' 2 >"$test_secret_directory/postgres_runtime_password"
  chmod 0444 "$test_secret_directory"/*
  docker run --rm -d \
    --name "$test_container" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_DB=roomframe_test \
    -e POSTGRES_USER=roomframe \
    --mount "type=bind,source=$test_secret_directory/postgres_password,target=/run/secrets/postgres_password,readonly" \
    --mount "type=bind,source=$test_secret_directory/postgres_migrator_password,target=/run/secrets/postgres_migrator_password,readonly" \
    --mount "type=bind,source=$test_secret_directory/postgres_runtime_password,target=/run/secrets/postgres_runtime_password,readonly" \
    --mount "type=bind,source=$ROOT/scripts/postgres-bootstrap-roles.sh,target=/opt/roomframe/postgres-bootstrap-roles.sh,readonly" \
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
  docker exec \
    -e ROOMFRAME_DB_HOST=/var/run/postgresql \
    -e ROOMFRAME_DB_NAME=roomframe_test \
    "$test_container" \
    /opt/roomframe/postgres-bootstrap-roles.sh

  (
    cd services/api
    ROOMFRAME_DB_HOST="$ROOMFRAME_TEST_DB_HOST" \
    ROOMFRAME_DB_PORT="$ROOMFRAME_TEST_DB_PORT" \
    ROOMFRAME_DB_NAME="$ROOMFRAME_TEST_DB_NAME" \
    ROOMFRAME_DB_USER=roomframe_migrator \
    ROOMFRAME_DB_PASSWORD_FILE="$test_secret_directory/postgres_migrator_password" \
    ROOMFRAME_DB_MIGRATION_ROLE=roomframe_owner \
    ROOMFRAME_DB_RUNTIME_ROLE=roomframe_runtime \
    ROOMFRAME_MIGRATIONS_DIR="$ROOT/database/migrations" \
      "$NODE_BIN" src/migrate.mjs
  )

  docker exec "$test_container" \
    psql --username=roomframe --dbname=roomframe_test --set ON_ERROR_STOP=1 \
      --command 'CREATE TABLE public.legacy_role_upgrade_probe (id integer)' \
      >/dev/null
  docker exec \
    -e ROOMFRAME_DB_HOST=/var/run/postgresql \
    -e ROOMFRAME_DB_NAME=roomframe_test \
    "$test_container" \
    /opt/roomframe/postgres-bootstrap-roles.sh
  legacy_probe="$(
    docker exec "$test_container" \
      psql --username=roomframe --dbname=roomframe_test \
        --tuples-only --no-align --set ON_ERROR_STOP=1 \
        --command "
          SELECT
            pg_get_userbyid(relowner) = 'roomframe_owner'
            AND has_table_privilege(
              'roomframe_runtime',
              'public.legacy_role_upgrade_probe',
              'SELECT,INSERT,UPDATE,DELETE'
            )
          FROM pg_class
          WHERE oid = 'public.legacy_role_upgrade_probe'::regclass;
        "
  )"
  [[ "$legacy_probe" == "t" ]] || {
    echo "La reprise d'une table PostgreSQL historique a échoué." >&2
    exit 1
  }
  docker exec "$test_container" \
    psql --username=roomframe --dbname=roomframe_test --set ON_ERROR_STOP=1 \
      --command 'DROP TABLE public.legacy_role_upgrade_probe' \
      >/dev/null

  docker exec "$test_container" \
    pg_dump --format=custom --no-owner --no-privileges \
      --username=roomframe --dbname=roomframe_test \
      >"$test_secret_directory/postgres.dump"
  chmod 0444 "$test_secret_directory/postgres.dump"
  verify_container="roomframe-test-restore-$$"
  docker run --rm -d \
    --name "$verify_container" \
    --network none \
    --mount "type=bind,source=$test_secret_directory/postgres.dump,target=/backup/postgres.dump,readonly" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_DB=roomframe_restore_test \
    -e POSTGRES_USER=roomframe \
    --health-cmd='pg_isready -U roomframe -d roomframe_restore_test' \
    --health-interval=1s \
    --health-timeout=2s \
    --health-retries=30 \
    postgres:17-alpine >/dev/null
  for _ in $(seq 1 40); do
    verify_state="$(docker inspect --format '{{.State.Health.Status}}' "$verify_container")"
    [[ "$verify_state" == "healthy" ]] && break
    sleep 1
  done
  [[ "${verify_state:-}" == "healthy" ]] || {
    echo "PostgreSQL isolé de restauration n'est pas devenu sain." >&2
    exit 1
  }
  docker exec "$verify_container" \
    psql --username=roomframe --dbname=roomframe_restore_test \
      --set ON_ERROR_STOP=1 \
      --command 'CREATE ROLE roomframe_runtime NOLOGIN' \
      >/dev/null
  docker exec "$verify_container" \
    pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
      --username=roomframe --dbname=roomframe_restore_test \
      /backup/postgres.dump \
      >/dev/null
  docker stop "$verify_container" >/dev/null
  verify_container=""

  export ROOMFRAME_TEST_DB_USER=roomframe_runtime
  export ROOMFRAME_TEST_DB_PASSWORD=""
  export ROOMFRAME_TEST_DB_SPLIT_ROLES=1
  export ROOMFRAME_TEST_DB_MIGRATOR_USER=roomframe_migrator
  export ROOMFRAME_TEST_DB_MIGRATOR_PASSWORD=""
fi

certificate_test_directory="$(mktemp -d /tmp/roomframe-certificate-test.XXXXXX)"
openssl genpkey \
  -algorithm RSA \
  -pkeyopt rsa_keygen_bits:3072 \
  -out "$certificate_test_directory/ca.key" \
  >/dev/null 2>&1
openssl req \
  -x509 \
  -new \
  -key "$certificate_test_directory/ca.key" \
  -sha256 \
  -days 30 \
  -subj "/CN=RoomFrame Test Client CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$certificate_test_directory/ca.crt"
openssl genpkey \
  -algorithm RSA \
  -pkeyopt rsa_keygen_bits:2048 \
  -out "$certificate_test_directory/tv.key" \
  >/dev/null 2>&1
openssl pkey \
  -in "$certificate_test_directory/tv.key" \
  -pubout \
  -outform DER \
  -out "$certificate_test_directory/tv.der"
certificate_metadata="$(
  "$ROOT/scripts/issue-tv-certificate.sh" \
    --public-key-der "$certificate_test_directory/tv.der" \
    --ca-certificate "$certificate_test_directory/ca.crt" \
    --ca-private-key "$certificate_test_directory/ca.key" \
    --screen-id 11111111-1111-4111-8111-111111111111 \
    --serial AABBCCDDEEFF00112233445566778899 \
    --output "$certificate_test_directory/tv.crt"
)"
[[ "$certificate_metadata" =~ ^[a-f0-9]{64}$'\t'AABBCCDDEEFF00112233445566778899$'\t' ]] || {
  echo "Métadonnées du certificat client TV invalides." >&2
  exit 1
}
openssl verify \
  -CAfile "$certificate_test_directory/ca.crt" \
  -purpose sslclient \
  "$certificate_test_directory/tv.crt" \
  >/dev/null

"$NODE_BIN" --test prototype/admin/*.test.mjs prototype/tv/*.test.mjs
(
  cd services/api
  "$NODE_BIN" scripts/check-syntax.mjs
  "$NODE_BIN" --test --test-concurrency=1 test/*.test.mjs
)

printf '%s\n' "Tests RoomFrame réussis."
