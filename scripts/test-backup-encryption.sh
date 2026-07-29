#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf '%s\n' "Ce test de sauvegarde doit être lancé dans un conteneur root." >&2
  exit 1
}
for command_name in age age-keygen openssl python3 tar sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Dépendance de test absente: %s\n' "$command_name" >&2
    exit 1
  }
done

TEST_ROOT="$(mktemp -d /tmp/roomframe-backup-test.XXXXXX)"
cleanup() {
  if [[ -d "$TEST_ROOT" ]]; then
    find "$TEST_ROOT" -xdev -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$TEST_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

CONFIG_DIR="$TEST_ROOT/config"
DATA_DIR="$TEST_ROOT/data"
INSTALL_DIR="$TEST_ROOT/install"
mkdir -p "$INSTALL_DIR/scripts"
install -m 0755 \
  "$ROOT/scripts/test-fixtures/backup-fake-compose.sh" \
  "$INSTALL_DIR/scripts/roomframe-compose.sh"
install -m 0755 \
  "$ROOT/scripts/test-fixtures/backup-fake-verify.sh" \
  "$INSTALL_DIR/scripts/roomframe-verify-backup.sh"

ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$ROOT/defaults/experience" \
ROOMFRAME_RUNTIME_UID=65534 \
ROOMFRAME_RUNTIME_GID=65534 \
  "$ROOT/scripts/bootstrap.sh" >/dev/null

identity="$CONFIG_DIR/secrets/backup_age_identity"
identity_hash_before="$(sha256sum "$identity" | awk '{print $1}')"
ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$ROOT/defaults/experience" \
ROOMFRAME_RUNTIME_UID=65534 \
ROOMFRAME_RUNTIME_GID=65534 \
  "$ROOT/scripts/bootstrap.sh" >/dev/null
identity_hash_after="$(sha256sum "$identity" | awk '{print $1}')"
[[ "$identity_hash_before" == "$identity_hash_after" ]] \
  || { printf '%s\n' "L'identité age a été régénérée." >&2; exit 1; }
[[ "$(stat -c '%a:%u:%g' "$identity")" == "400:0:0" ]] \
  || { printf '%s\n' "Permissions de l'identité age invalides." >&2; exit 1; }
[[ "$(find "$DATA_DIR/backup-keyring" -maxdepth 1 -type f -name '*.agekey' | wc -l)" -eq 1 ]] \
  || { printf '%s\n' "Le trousseau age n'est pas idempotent." >&2; exit 1; }

cat >"$CONFIG_DIR/runtime.conf" <<RUNTIME
ROOMFRAME_VERSION=test
ROOMFRAME_INSTALL_DIR=$INSTALL_DIR
ROOMFRAME_CONFIG_DIR=$CONFIG_DIR
ROOMFRAME_DATA_DIR=$DATA_DIR
ROOMFRAME_RUNTIME_UID=65534
ROOMFRAME_RUNTIME_GID=65534
ROOMFRAME_BACKUP_DAILY_KEEP=2
ROOMFRAME_BACKUP_WEEKLY_KEEP=2
RUNTIME
chmod 0640 "$CONFIG_DIR/runtime.conf"
chown root:root "$CONFIG_DIR/runtime.conf"
printf '%s\n' "contenu média de test" >"$DATA_DIR/media/probe.txt"

mkdir "$TEST_ROOT/offline"
ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  "$ROOT/scripts/roomframe-backup-key.sh" \
    --export-identity "$TEST_ROOT/offline/roomframe-backup.agekey" >/dev/null
[[ "$(stat -c '%a:%u:%g' "$TEST_ROOT/offline/roomframe-backup.agekey")" == "600:0:0" ]] \
  || { printf '%s\n' "Permissions de l'export age invalides." >&2; exit 1; }
if ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  "$ROOT/scripts/roomframe-backup-key.sh" \
    --export-identity "$TEST_ROOT/offline/roomframe-backup.agekey" >/dev/null 2>&1; then
  printf '%s\n' "L'export age a écrasé une destination existante." >&2
  exit 1
fi

manual_output="$(
  ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
  ROOMFRAME_MAINTENANCE_LOCK_FILE="$TEST_ROOT/maintenance.lock" \
    "$ROOT/scripts/roomframe-backup.sh" --without-media
)"

manual_backup="$(
  sed -n 's/^ROOMFRAME_BACKUP_PATH=//p' <<<"$manual_output" | tail -n 1
)"
[[ -n "$manual_backup" ]] || { printf '%s\n' "Sauvegarde absente." >&2; exit 1; }
[[ -d "$manual_backup" && "$(dirname "$manual_backup")" == "$DATA_DIR/backups" ]] \
  || { printf '%s\n' "Chemin machine de sauvegarde invalide." >&2; exit 1; }
expected_files="$(
  printf '%s\n' \
    configuration.tar.gz.age \
    metadata.json \
    persistent-data.tar.gz.age \
    postgres.dump.age \
    SHA256SUMS | sort
)"
actual_files="$(
  find "$manual_backup" -mindepth 1 -maxdepth 1 -type f \
    -exec basename {} \; | sort
)"
[[ "$actual_files" == "$expected_files" ]] \
  || { printf '%s\n' "Enveloppe de sauvegarde inattendue." >&2; exit 1; }

materialized="$TEST_ROOT/materialized"
mkdir -m 0700 "$materialized"
for filename in configuration.tar.gz persistent-data.tar.gz postgres.dump; do
  age --decrypt \
    --identity "$identity" \
    --output "$materialized/$filename" \
    "$manual_backup/$filename.age" >/dev/null
done
[[ "$(cat "$materialized/postgres.dump")" == "ROOMFRAME-FAKE-POSTGRES-CUSTOM-DUMP" ]] \
  || { printf '%s\n' "Dump déchiffré incohérent." >&2; exit 1; }
if tar -tzf "$materialized/persistent-data.tar.gz" \
  | grep -Eq '(^|/)backup-keyring(/|$)|(^|/)media(/|$)'; then
  printf '%s\n' "Le quotidien sans médias contient une racine exclue." >&2
  exit 1
fi

tampered="$TEST_ROOT/tampered.age"
cp "$manual_backup/postgres.dump.age" "$tampered"
printf 'x' >>"$tampered"
if age --decrypt --identity "$identity" "$tampered" >/dev/null 2>&1; then
  printf '%s\n' "Un payload age altéré a été accepté." >&2
  exit 1
fi

for backup_id in 20200101T000000Z 20200102T000000Z 20200103T000000Z; do
  mkdir -m 0700 "$DATA_DIR/backups/$backup_id"
  printf '%s\n' '{"formatVersion":2,"backupClass":"scheduled-daily"}' \
    >"$DATA_DIR/backups/$backup_id/metadata.json"
done
manual_id="$(basename "$manual_backup")"
sleep 1
ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
ROOMFRAME_MAINTENANCE_LOCK_FILE="$TEST_ROOT/maintenance.lock" \
ROOMFRAME_VERIFY_BACKUP_COMMAND="$INSTALL_DIR/scripts/roomframe-verify-backup.sh" \
  "$ROOT/scripts/roomframe-backup.sh" --scheduled daily >/dev/null

scheduled_count="$(
  python3 - "$DATA_DIR/backups" <<'PY'
import json
import pathlib
import sys
count = 0
for metadata_path in pathlib.Path(sys.argv[1]).glob("*/metadata.json"):
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, ValueError):
        continue
    count += metadata.get("backupClass") == "scheduled-daily"
print(count)
PY
)"
[[ "$scheduled_count" -eq 2 ]] \
  || { printf '%s\n' "La rétention quotidienne n'a pas gardé exactement 2 points." >&2; exit 1; }
[[ -d "$DATA_DIR/backups/$manual_id" ]] \
  || { printf '%s\n' "La rétention a supprimé une sauvegarde manuelle." >&2; exit 1; }

printf '%s\n' "Test de chiffrement, idempotence et rétention réussi."
