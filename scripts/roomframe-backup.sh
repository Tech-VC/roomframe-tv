#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
INCLUDE_MEDIA=1
WITHOUT_MEDIA_EXPLICIT=0
BACKUP_CLASS="manual"
STAGING=""
FINALIZED=0
declare -a PAUSED_SERVICES=()

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-backup [--without-media]
  sudo roomframe-backup --scheduled daily|weekly

Crée une sauvegarde age chiffrée de PostgreSQL, de la configuration, de la PKI
et des données persistantes. Caddy, l'API, le worker et le poller d'updates
sont brièvement mis en pause.

Le cycle planifié conserve par défaut 14 sauvegardes quotidiennes sans médias
et 4 sauvegardes hebdomadaires complètes. Il ne supprime jamais une sauvegarde
manuelle ou pré-migration.
USAGE
}

fail() {
  printf 'Sauvegarde refusée: %s\n' "$*" >&2
  exit 1
}

remove_tree() {
  local path="$1" allowed_parent="$2"
  [[ -n "$path" && -d "$path" && ! -L "$path" ]] || return 0
  [[ "$(dirname "$path")" == "$allowed_parent" ]] || return 1
  find "$path" -xdev -depth -mindepth 1 -delete
  rmdir "$path"
}

resume_services() {
  if ((${#PAUSED_SERVICES[@]} > 0)); then
    "$COMPOSE_COMMAND" unpause "${PAUSED_SERVICES[@]}" >/dev/null 2>&1 || true
    PAUSED_SERVICES=()
  fi
}

cleanup() {
  resume_services
  if [[ "$FINALIZED" -eq 0 && -n "$STAGING" && -d "$STAGING" ]]; then
    remove_tree "$STAGING" "$BACKUP_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --without-media)
      INCLUDE_MEDIA=0
      WITHOUT_MEDIA_EXPLICIT=1
      shift
      ;;
    --scheduled)
      [[ $# -ge 2 && "$BACKUP_CLASS" == "manual" ]] \
        || fail "la classe planifiée daily|weekly est requise une seule fois"
      case "$2" in
        daily)
          BACKUP_CLASS="scheduled-daily"
          INCLUDE_MEDIA=0
          ;;
        weekly)
          BACKUP_CLASS="scheduled-weekly"
          INCLUDE_MEDIA=1
          ;;
        *)
          fail "classe planifiée inconnue: $2"
          ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "option inconnue: $1"
      ;;
  esac
done

if [[ "$BACKUP_CLASS" != "manual" && "$WITHOUT_MEDIA_EXPLICIT" -eq 1 ]]; then
  fail "--without-media ne se combine pas avec --scheduled"
fi

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"

if [[ "${ROOMFRAME_MAINTENANCE_LOCK_HELD:-0}" != "1" ]]; then
  MAINTENANCE_LOCK_FILE="${ROOMFRAME_MAINTENANCE_LOCK_FILE:-/run/lock/roomframe-install.lock}"
  mkdir -p "$(dirname "$MAINTENANCE_LOCK_FILE")"
  exec 8>"$MAINTENANCE_LOCK_FILE"
  flock -n 8 || fail "une opération de maintenance RoomFrame est déjà en cours"
fi

[[ -r "$RUNTIME_CONFIG" ]] \
  || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"
VERIFY_COMMAND="${ROOMFRAME_VERIFY_BACKUP_COMMAND:-$INSTALL_DIR/scripts/roomframe-verify-backup.sh}"
BACKUP_ROOT="$DATA_DIR/backups"
IDENTITY_FILE="${ROOMFRAME_BACKUP_IDENTITY_FILE:-$CONFIG_DIR/secrets/backup_age_identity}"
DAILY_KEEP="${ROOMFRAME_BACKUP_DAILY_KEEP:-14}"
WEEKLY_KEEP="${ROOMFRAME_BACKUP_WEEKLY_KEEP:-4}"

[[ "$DAILY_KEEP" =~ ^[0-9]+$ ]] && ((10#$DAILY_KEEP >= 2 && 10#$DAILY_KEEP <= 90)) \
  || fail "ROOMFRAME_BACKUP_DAILY_KEEP doit être compris entre 2 et 90"
[[ "$WEEKLY_KEEP" =~ ^[0-9]+$ ]] && ((10#$WEEKLY_KEEP >= 2 && 10#$WEEKLY_KEEP <= 26)) \
  || fail "ROOMFRAME_BACKUP_WEEKLY_KEEP doit être compris entre 2 et 26"
[[ -x "$COMPOSE_COMMAND" ]] \
  || fail "commande Compose RoomFrame introuvable: $COMPOSE_COMMAND"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] \
  || fail "répertoire de sauvegardes invalide: $BACKUP_ROOT"
[[ -f "$IDENTITY_FILE" && -s "$IDENTITY_FILE" && ! -L "$IDENTITY_FILE" ]] \
  || fail "identité age de sauvegarde absente ou invalide"
[[ "$(stat -c '%a:%u:%g' "$IDENTITY_FILE")" == "400:0:0" ]] \
  || fail "l'identité age doit appartenir à root:root en mode 0400"
command -v age >/dev/null 2>&1 || fail "age est introuvable"
command -v age-keygen >/dev/null 2>&1 || fail "age-keygen est introuvable"

recipient="$(age-keygen -y "$IDENTITY_FILE" 2>/dev/null)"
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || fail "identité age illisible"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_ROOT/$STAMP"
[[ ! -e "$FINAL" ]] \
  || fail "une sauvegarde existe déjà pour cet horodatage: $FINAL"
STAGING="$(mktemp -d "$BACKUP_ROOT/.incomplete-${STAMP}.XXXXXX")"
chmod 0700 "$STAGING"

running_services="$(
  "$COMPOSE_COMMAND" ps --status running --services 2>/dev/null \
    || "$COMPOSE_COMMAND" ps --services --filter status=running 2>/dev/null \
    || true
)"
for service_name in caddy api worker weather-gateway update-poller; do
  if grep -Fqx "$service_name" <<<"$running_services"; then
    PAUSED_SERVICES+=("$service_name")
  fi
done
if ((${#PAUSED_SERVICES[@]} > 0)); then
  "$COMPOSE_COMMAND" pause "${PAUSED_SERVICES[@]}" >/dev/null
fi

printf '%s\n' "Sauvegarde PostgreSQL chiffrée…"
"$COMPOSE_COMMAND" exec -T postgres \
  pg_dump --format=custom --no-owner --no-privileges \
  --username=roomframe --dbname=roomframe \
  | age --recipient "$recipient" --output "$STAGING/postgres.dump.age"

printf '%s\n' "Sauvegarde chiffrée de la configuration et de la PKI…"
tar \
  --exclude='.env*' \
  --exclude='*/.env*' \
  -C "$(dirname "$CONFIG_DIR")" -czf - \
  "$(basename "$CONFIG_DIR")" \
  | age --recipient "$recipient" --output "$STAGING/configuration.tar.gz.age"

data_excludes=(
  "--exclude=./backups"
  "--exclude=./backup-keyring"
  "--exclude=./postgres"
  "--exclude=./processing"
  "--exclude=.env*"
  "--exclude=*/.env*"
)
if [[ "$INCLUDE_MEDIA" -eq 0 ]]; then
  data_excludes+=("--exclude=./media")
fi
tar "${data_excludes[@]}" -C "$DATA_DIR" -czf - . \
  | age --recipient "$recipient" --output "$STAGING/persistent-data.tar.gz.age"

python3 - \
  "$STAGING/metadata.json" \
  "${ROOMFRAME_VERSION:-unknown}" \
  "$INCLUDE_MEDIA" \
  "$BACKUP_CLASS" \
  "$recipient" <<'PY'
import hashlib
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

path = pathlib.Path(sys.argv[1])
recipient = sys.argv[5]
metadata = {
    "formatVersion": 2,
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "softwareVersion": sys.argv[2],
    "includesMedia": sys.argv[3] == "1",
    "containsSensitiveConfiguration": True,
    "postgresFormat": "custom",
    "backupClass": sys.argv[4],
    "encryption": {
        "format": "age",
        "recipient": recipient,
        "recipientSha256": hashlib.sha256(recipient.encode()).hexdigest(),
    },
}
temporary = path.with_suffix(".tmp")
temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

(
  cd "$STAGING"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum >SHA256SUMS
)
chmod 0600 "$STAGING"/*
mv "$STAGING" "$FINAL"
FINALIZED=1
resume_services

printf 'Sauvegarde chiffrée terminée: %s\n' "$FINAL"
printf 'ROOMFRAME_BACKUP_PATH=%s\n' "$FINAL"
printf '%s\n' "Une reprise après perte du serveur exige l'identité exportée par roomframe-backup-key."

if [[ "$BACKUP_CLASS" == "manual" ]]; then
  trap - EXIT
  exit 0
fi

[[ -x "$VERIFY_COMMAND" ]] \
  || fail "commande de vérification introuvable: $VERIFY_COMMAND"
"$VERIFY_COMMAND" "$FINAL"

if [[ "$BACKUP_CLASS" == "scheduled-daily" ]]; then
  retention_keep="$DAILY_KEEP"
else
  retention_keep="$WEEKLY_KEEP"
fi

mapfile -t prune_candidates < <(
  python3 - "$BACKUP_ROOT" "$BACKUP_CLASS" "$retention_keep" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
backup_class = sys.argv[2]
keep = int(sys.argv[3])
pattern = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
matching = []
for child in root.iterdir():
    if not child.is_dir() or child.is_symlink() or not pattern.fullmatch(child.name):
        continue
    try:
        metadata = json.loads((child / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    if metadata.get("formatVersion") == 2 and metadata.get("backupClass") == backup_class:
        matching.append(child.name)
for name in sorted(matching, reverse=True)[keep:]:
    print(name)
PY
)

for backup_id in "${prune_candidates[@]}"; do
  [[ "$backup_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
    || fail "identifiant de rétention inattendu"
  candidate="$BACKUP_ROOT/$backup_id"
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  candidate_real="$(realpath -e "$candidate")"
  [[ "$(dirname "$candidate_real")" == "$(realpath -e "$BACKUP_ROOT")" ]] \
    || fail "candidat de rétention hors du répertoire géré"
  remove_tree "$candidate_real" "$(realpath -e "$BACKUP_ROOT")"
  printf 'Sauvegarde planifiée arrivée en fin de rétention: %s\n' "$backup_id"
done

trap - EXIT
