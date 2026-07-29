#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf '%s\n' "Ce test E2E doit être lancé dans un environnement root jetable." >&2
  exit 1
}
for command_name in age age-keygen docker openssl python3 tar sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Dépendance E2E absente: %s\n' "$command_name" >&2
    exit 1
  }
done
docker info >/dev/null 2>&1 || {
  printf '%s\n' "Le démon Docker ne répond pas." >&2
  exit 1
}

TEST_PARENT="${ROOMFRAME_BACKUP_TEST_ROOT:-/tmp}"
[[ -d "$TEST_PARENT" && ! -L "$TEST_PARENT" ]] || {
  printf 'Racine de test invalide: %s\n' "$TEST_PARENT" >&2
  exit 1
}
TEST_ROOT="$(mktemp -d "$TEST_PARENT/roomframe-backup-e2e.XXXXXX")"
DATABASE_CONTAINER="roomframe-backup-e2e-$$"
cleanup() {
  docker rm --force "$DATABASE_CONTAINER" >/dev/null 2>&1 || true
  if [[ -d "$TEST_ROOT" ]]; then
    find "$TEST_ROOT" -xdev -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$TEST_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

docker run --detach \
  --name "$DATABASE_CONTAINER" \
  --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=roomframe \
  --env POSTGRES_USER=roomframe \
  postgres:17-alpine >/dev/null
ready=0
for _ in $(seq 1 40); do
  if docker exec "$DATABASE_CONTAINER" \
    psql \
      --username=roomframe \
      --dbname=roomframe \
      --tuples-only \
      --no-align \
      --command 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || {
  printf '%s\n' "PostgreSQL source n'est pas devenu disponible." >&2
  exit 1
}

docker exec -i "$DATABASE_CONTAINER" \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 <<'SQL' \
  >/dev/null
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL
);
INSERT INTO schema_migrations VALUES (
  '0001_backup_probe',
  repeat('a', 64)
);
CREATE TABLE roomframe_instance (id integer PRIMARY KEY);
CREATE TABLE scenes (id integer PRIMARY KEY);
CREATE TABLE media_jobs (id integer PRIMARY KEY);
SQL

CONFIG_DIR="$TEST_ROOT/config"
DATA_DIR="$TEST_ROOT/data"
INSTALL_DIR="$TEST_ROOT/install"
mkdir -p "$INSTALL_DIR/scripts"
install -m 0755 "$ROOT/scripts/roomframe-verify-backup.sh" \
  "$INSTALL_DIR/scripts/roomframe-verify-backup.sh"

compose_proxy="$INSTALL_DIR/scripts/roomframe-compose.sh"
cat >"$compose_proxy" <<COMPOSE
#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-}" in
  ps)
    exit 0
    ;;
  exec)
    shift
    [[ "\${1:-}" == "-T" ]] && shift
    [[ "\${1:-}" == "postgres" ]] || exit 2
    shift
    exec docker exec -i "$DATABASE_CONTAINER" "\$@"
    ;;
  pause|unpause)
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
COMPOSE
chmod 0755 "$compose_proxy"

ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$ROOT/defaults/experience" \
ROOMFRAME_RUNTIME_UID=65534 \
ROOMFRAME_RUNTIME_GID=65534 \
  "$ROOT/scripts/bootstrap.sh" >/dev/null
cat >"$CONFIG_DIR/runtime.conf" <<RUNTIME
ROOMFRAME_VERSION=test-e2e
ROOMFRAME_INSTALL_DIR=$INSTALL_DIR
ROOMFRAME_CONFIG_DIR=$CONFIG_DIR
ROOMFRAME_DATA_DIR=$DATA_DIR
ROOMFRAME_RUNTIME_UID=65534
ROOMFRAME_RUNTIME_GID=65534
RUNTIME
chmod 0640 "$CONFIG_DIR/runtime.conf"
chown root:root "$CONFIG_DIR/runtime.conf"

ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
ROOMFRAME_MAINTENANCE_LOCK_FILE="$TEST_ROOT/maintenance.lock" \
  "$ROOT/scripts/roomframe-backup.sh" >/dev/null
backup="$(
  find "$DATA_DIR/backups" -mindepth 1 -maxdepth 1 -type d \
    -name '????????T??????Z' -print | sort | tail -n 1
)"
[[ -n "$backup" ]] || {
  printf '%s\n' "La sauvegarde E2E n'a pas été créée." >&2
  exit 1
}

ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  "$ROOT/scripts/roomframe-verify-backup.sh" "$backup" >/dev/null

rm -f "$CONFIG_DIR/secrets/backup_age_identity"
age-keygen -o "$CONFIG_DIR/secrets/backup_age_identity" >/dev/null 2>&1
chmod 0400 "$CONFIG_DIR/secrets/backup_age_identity"
chown root:root "$CONFIG_DIR/secrets/backup_age_identity"
ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$ROOT/defaults/experience" \
ROOMFRAME_RUNTIME_UID=65534 \
ROOMFRAME_RUNTIME_GID=65534 \
  "$ROOT/scripts/bootstrap.sh" >/dev/null
[[ "$(find "$DATA_DIR/backup-keyring" -maxdepth 1 -type f -name '*.agekey' | wc -l)" -eq 2 ]] \
  || {
    printf '%s\n' "Le trousseau n'a pas conservé les deux identités." >&2
    exit 1
  }
ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  "$ROOT/scripts/roomframe-verify-backup.sh" "$backup" >/dev/null

tampered_id="20991231T235959Z"
tampered="$DATA_DIR/backups/$tampered_id"
cp -a "$backup" "$tampered"
printf 'x' >>"$tampered/postgres.dump.age"
(
  cd "$tampered"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum >SHA256SUMS
)
chmod 0600 "$tampered"/*
if ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  "$ROOT/scripts/roomframe-verify-backup.sh" "$tampered" >/dev/null 2>&1; then
  printf '%s\n' "Le vérificateur a accepté un ciphertext age altéré." >&2
  exit 1
fi

if find "$DATA_DIR/backups" -mindepth 1 -maxdepth 1 -type d \
  -name '.verify-*' -print -quit | grep -q .; then
  printf '%s\n' "Un staging déchiffré a été conservé." >&2
  exit 1
fi

printf '%s\n' "Test E2E de sauvegarde chiffrée et restauration isolée réussi."
