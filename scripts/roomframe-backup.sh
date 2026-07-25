#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
INCLUDE_MEDIA=1

usage() {
  cat <<'USAGE'
Usage: sudo roomframe-backup [--without-media]

Crée une sauvegarde cohérente de PostgreSQL, de la configuration, de la PKI et
des données persistantes. L'API et le worker sont brièvement mis en pause.
USAGE
}

while (($#)); do
  case "$1" in
    --without-media) INCLUDE_MEDIA=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécutez la sauvegarde avec sudo/root." >&2
  exit 1
}
[[ -r "$RUNTIME_CONFIG" ]] || {
  echo "Configuration runtime introuvable: $RUNTIME_CONFIG" >&2
  exit 1
}

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"
BACKUP_ROOT="$DATA_DIR/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_ROOT/$STAMP"
STAGING="$(mktemp -d "$BACKUP_ROOT/.incomplete-${STAMP}.XXXXXX")"
declare -a PAUSED_SERVICES=()

resume_services() {
  if ((${#PAUSED_SERVICES[@]} > 0)); then
    "$COMPOSE_COMMAND" unpause "${PAUSED_SERVICES[@]}" >/dev/null 2>&1 || true
  fi
}
trap resume_services EXIT

[[ -x "$COMPOSE_COMMAND" ]] || {
  echo "Commande Compose RoomFrame introuvable: $COMPOSE_COMMAND" >&2
  exit 1
}
[[ ! -e "$FINAL" ]] || {
  echo "Une sauvegarde existe déjà pour cet horodatage: $FINAL" >&2
  exit 1
}
chmod 0700 "$STAGING"

running_services="$(
  "$COMPOSE_COMMAND" ps --status running --services 2>/dev/null \
    || "$COMPOSE_COMMAND" ps --services --filter status=running 2>/dev/null \
    || true
)"
for service_name in api worker; do
  if grep -Fqx "$service_name" <<<"$running_services"; then
    PAUSED_SERVICES+=("$service_name")
  fi
done
if ((${#PAUSED_SERVICES[@]} > 0)); then
  "$COMPOSE_COMMAND" pause "${PAUSED_SERVICES[@]}" >/dev/null
fi

printf '%s\n' "Sauvegarde PostgreSQL…"
"$COMPOSE_COMMAND" exec -T postgres \
  pg_dump --format=custom --no-owner --no-privileges \
  --username=roomframe --dbname=roomframe \
  >"$STAGING/postgres.dump"

printf '%s\n' "Sauvegarde de la configuration et de la PKI…"
tar \
  --exclude='.env*' \
  --exclude='*/.env*' \
  -C "$(dirname "$CONFIG_DIR")" -czf "$STAGING/configuration.tar.gz" \
  "$(basename "$CONFIG_DIR")"

data_excludes=(
  "--exclude=./backups"
  "--exclude=./postgres"
  "--exclude=./processing"
  "--exclude=.env*"
  "--exclude=*/.env*"
)
if [[ "$INCLUDE_MEDIA" -eq 0 ]]; then
  data_excludes+=("--exclude=./media")
fi
tar "${data_excludes[@]}" -C "$DATA_DIR" -czf "$STAGING/persistent-data.tar.gz" .

python3 - "$STAGING/metadata.json" "${ROOMFRAME_VERSION:-unknown}" "$INCLUDE_MEDIA" <<'PY'
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

path = pathlib.Path(sys.argv[1])
metadata = {
    "formatVersion": 1,
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "softwareVersion": sys.argv[2],
    "includesMedia": sys.argv[3] == "1",
    "containsSensitiveConfiguration": True,
    "postgresFormat": "custom",
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
resume_services
PAUSED_SERVICES=()
trap - EXIT

printf 'Sauvegarde terminée: %s\n' "$FINAL"
printf '%s\n' "Conservez ce répertoire comme un secret: il contient la configuration et la PKI."
