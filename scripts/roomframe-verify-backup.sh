#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
POSTGRES_IMAGE="${ROOMFRAME_POSTGRES_IMAGE:-postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193}"
BACKUP_DIRECTORY=""
USE_LATEST=0
VERIFY_CONTAINER=""

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-verify-backup --latest
  sudo roomframe-verify-backup /var/lib/roomframe/backups/20260727T213916Z

Vérifie les checksums, les métadonnées et la sûreté des archives, puis restaure
le dump PostgreSQL dans un conteneur Docker isolé sans port ni accès réseau.
La base RoomFrame installée n'est jamais modifiée.
USAGE
}

fail() {
  printf 'Vérification de sauvegarde refusée: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$VERIFY_CONTAINER" ]]; then
    docker rm --force "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --latest)
      [[ "$USE_LATEST" -eq 0 && -z "$BACKUP_DIRECTORY" ]] \
        || fail "choisissez soit --latest, soit un répertoire explicite"
      USE_LATEST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "option inconnue: $1"
      ;;
    *)
      [[ "$USE_LATEST" -eq 0 && -z "$BACKUP_DIRECTORY" ]] \
        || fail "un seul répertoire de sauvegarde est accepté"
      BACKUP_DIRECTORY="$1"
      shift
      ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ -r "$RUNTIME_CONFIG" ]] || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
BACKUP_ROOT="$DATA_DIR/backups"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] \
  || fail "répertoire de sauvegardes invalide: $BACKUP_ROOT"

if [[ "$USE_LATEST" -eq 1 ]]; then
  BACKUP_DIRECTORY="$(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -name '????????T??????Z' -print | sort | tail -n 1
  )"
  [[ -n "$BACKUP_DIRECTORY" ]] || fail "aucune sauvegarde disponible"
fi
[[ -n "$BACKUP_DIRECTORY" ]] || {
  usage >&2
  exit 2
}
[[ -d "$BACKUP_DIRECTORY" && ! -L "$BACKUP_DIRECTORY" ]] \
  || fail "répertoire absent ou symbolique: $BACKUP_DIRECTORY"

BACKUP_ROOT_REAL="$(realpath -e "$BACKUP_ROOT")"
BACKUP_REAL="$(realpath -e "$BACKUP_DIRECTORY")"
[[ "$(dirname "$BACKUP_REAL")" == "$BACKUP_ROOT_REAL" ]] \
  || fail "la sauvegarde doit être un enfant direct de $BACKUP_ROOT_REAL"
[[ "$(basename "$BACKUP_REAL")" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  || fail "nom de sauvegarde invalide"

EXPECTED_FILES=(
  configuration.tar.gz
  metadata.json
  persistent-data.tar.gz
  postgres.dump
  SHA256SUMS
)
for filename in "${EXPECTED_FILES[@]}"; do
  path="$BACKUP_REAL/$filename"
  [[ -f "$path" && ! -L "$path" ]] || fail "fichier requis absent ou symbolique: $filename"
done

unexpected="$(
  find "$BACKUP_REAL" -mindepth 1 -maxdepth 1 ! -type f -print -quit
)"
[[ -z "$unexpected" ]] || fail "entrée non régulière dans la sauvegarde"

actual_files="$(
  find "$BACKUP_REAL" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | sort
)"
expected_files="$(
  printf '%s\n' "${EXPECTED_FILES[@]}" | sort
)"
[[ "$actual_files" == "$expected_files" ]] \
  || fail "liste de fichiers incomplète ou inattendue"

[[ "$(stat -c '%a' "$BACKUP_REAL")" == "700" ]] \
  || fail "le répertoire de sauvegarde doit être en mode 0700"
for filename in "${EXPECTED_FILES[@]}"; do
  [[ "$(stat -c '%a' "$BACKUP_REAL/$filename")" == "600" ]] \
    || fail "le fichier $filename doit être en mode 0600"
done

python3 - "$BACKUP_REAL/SHA256SUMS" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
expected = {
    "./configuration.tar.gz",
    "./metadata.json",
    "./persistent-data.tar.gz",
    "./postgres.dump",
}
seen = set()
pattern = re.compile(r"^([0-9a-f]{64})  (\./[A-Za-z0-9._-]+)$")
for line in path.read_text(encoding="utf-8").splitlines():
    match = pattern.fullmatch(line)
    if not match:
        raise SystemExit("format SHA256SUMS invalide")
    filename = match.group(2)
    if filename in seen:
        raise SystemExit("entrée SHA256SUMS dupliquée")
    seen.add(filename)
if seen != expected:
    raise SystemExit("liste SHA256SUMS incomplète ou inattendue")
PY

(
  cd "$BACKUP_REAL"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
printf '%s\n' "[OK] Checksums"

python3 - "$BACKUP_REAL/metadata.json" <<'PY'
import datetime
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
metadata = json.loads(path.read_text(encoding="utf-8"))
if set(metadata) != {
    "formatVersion",
    "createdAt",
    "softwareVersion",
    "includesMedia",
    "containsSensitiveConfiguration",
    "postgresFormat",
}:
    raise SystemExit("clés metadata.json invalides")
if metadata["formatVersion"] != 1 or metadata["postgresFormat"] != "custom":
    raise SystemExit("format de sauvegarde incompatible")
if not isinstance(metadata["softwareVersion"], str) or not metadata["softwareVersion"]:
    raise SystemExit("version logicielle absente")
if not isinstance(metadata["includesMedia"], bool):
    raise SystemExit("indicateur includesMedia invalide")
if metadata["containsSensitiveConfiguration"] is not True:
    raise SystemExit("indicateur de sensibilité invalide")
created_at = metadata["createdAt"]
if not isinstance(created_at, str):
    raise SystemExit("date de sauvegarde invalide")
datetime.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
PY
printf '%s\n' "[OK] Métadonnées"

python3 - "$BACKUP_REAL/configuration.tar.gz" "$BACKUP_REAL/persistent-data.tar.gz" <<'PY'
import pathlib
import sys
import tarfile

def validate(archive_path):
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise SystemExit(f"archive vide: {archive_path.name}")
        for member in members:
            name = member.name
            pure = pathlib.PurePosixPath(name)
            if (
                pure.is_absolute()
                or ".." in pure.parts
                or any(ord(character) < 32 for character in name)
                or member.issym()
                or member.islnk()
                or member.isdev()
                or member.isfifo()
                or not (member.isdir() or member.isfile())
            ):
                raise SystemExit(f"entrée d'archive non sûre: {archive_path.name}")

for value in sys.argv[1:]:
    validate(pathlib.Path(value))
PY
printf '%s\n' "[OK] Archives sûres"

command -v docker >/dev/null 2>&1 || fail "Docker est introuvable"
docker info >/dev/null 2>&1 || fail "le démon Docker ne répond pas"

VERIFY_CONTAINER="roomframe-backup-verify-$$-$(date +%s)"
docker run --detach \
  --name "$VERIFY_CONTAINER" \
  --network none \
  --mount "type=bind,source=$BACKUP_REAL,target=/backup,readonly" \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env POSTGRES_DB=roomframe_restore_test \
  --env POSTGRES_USER=roomframe \
  --pids-limit 256 \
  --memory 1g \
  --cpus 1 \
  "$POSTGRES_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 40); do
  if docker exec "$VERIFY_CONTAINER" \
    pg_isready --username=roomframe --dbname=roomframe_restore_test >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || fail "PostgreSQL isolé n'est pas devenu disponible"

docker exec "$VERIFY_CONTAINER" \
  psql \
    --username=roomframe \
    --dbname=roomframe_restore_test \
    --set ON_ERROR_STOP=1 \
    --command 'CREATE ROLE roomframe_runtime NOLOGIN' \
    >/dev/null

docker exec "$VERIFY_CONTAINER" \
  pg_restore \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges \
    --username=roomframe \
    --dbname=roomframe_restore_test \
    /backup/postgres.dump >/dev/null

database_check="$(
  docker exec "$VERIFY_CONTAINER" \
    psql \
      --username=roomframe \
      --dbname=roomframe_restore_test \
      --tuples-only \
      --no-align \
      --set ON_ERROR_STOP=1 \
      --command "
        SELECT
          (SELECT count(*) > 0 FROM schema_migrations)
          AND (SELECT bool_and(version ~ '^[0-9]{4}_[a-z0-9_]+$'
                               AND checksum_sha256 ~ '^[0-9a-f]{64}$')
               FROM schema_migrations)
          AND to_regclass('public.roomframe_instance') IS NOT NULL
          AND to_regclass('public.scenes') IS NOT NULL
          AND to_regclass('public.media_jobs') IS NOT NULL;
      "
)"
[[ "$database_check" == "t" ]] || fail "contrôle d'intégrité SQL négatif"
printf '%s\n' "[OK] Dump restauré dans PostgreSQL isolé"

cleanup
VERIFY_CONTAINER=""
trap - EXIT

printf 'Sauvegarde restaurable vérifiée: %s\n' "$BACKUP_REAL"
