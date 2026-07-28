#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
BACKUP_DIRECTORY=""
CONFIRMATION=""
CONFIG_STAGE=""
DATA_STAGE=""
DATA_ROLLBACK=""
SAFETY_BACKUP=""
RESTORE_ID=""
DATABASE_TEMP=""
DATABASE_PREVIOUS=""
DATABASE_SWAPPED=0
CONFIG_SWAPPED=0
ROLLBACK_RUNNING=0
declare -a DATA_SWAPPED=()

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-restore \
    /var/lib/roomframe/backups/20260101T120000Z \
    --confirm 20260101T120000Z

Restaure une sauvegarde complète explicitement désignée. La commande :
  1. vérifie la sauvegarde dans un PostgreSQL isolé ;
  2. crée et vérifie une sauvegarde de sécurité de l'état courant ;
  3. restaure configuration, PKI, médias, données et PostgreSQL ;
  4. redémarre la pile et contrôle sa santé ;
  5. revient automatiquement à l'état précédent en cas d'échec.

Les sauvegardes créées avec --without-media et les sauvegardes d'une autre
version RoomFrame sont refusées. Aucun raccourci --latest n'est accepté.
USAGE
}

fail() {
  local message="$*"
  trap - ERR
  printf 'Restauration refusée: %s\n' "$message" >&2
  if [[ "$ROLLBACK_RUNNING" -eq 0 ]] \
    && [[ "$CONFIG_SWAPPED" -eq 1 || "${#DATA_SWAPPED[@]}" -gt 0 || "$DATABASE_SWAPPED" -eq 1 ]]; then
    rollback_restore || true
  fi
  cleanup_staging
  exit 1
}

on_error() {
  local status=$? line="$1"
  trap - ERR
  fail "erreur inattendue à la ligne $line (code $status)"
}
trap 'on_error "$LINENO"' ERR

on_signal() {
  trap - HUP INT TERM
  fail "opération interrompue par un signal"
}
trap on_signal HUP INT TERM

remove_tree() {
  local path="$1" allowed_parent="$2"
  [[ -n "$path" && -d "$path" && ! -L "$path" ]] || return 0
  [[ "$(dirname "$path")" == "$allowed_parent" ]] \
    || return 1
  find "$path" -xdev -depth -mindepth 1 -delete
  rmdir "$path"
}

cleanup_staging() {
  local config_parent data_parent
  config_parent="$(dirname "$CONFIG_DIR")"
  data_parent="${DATA_DIR:-/var/lib/roomframe}"
  if [[ -n "$CONFIG_STAGE" ]]; then
    remove_tree "$CONFIG_STAGE" "$config_parent" 2>/dev/null || true
  fi
  if [[ -n "$DATA_STAGE" ]]; then
    remove_tree "$DATA_STAGE" "$data_parent" 2>/dev/null || true
  fi
  if [[ -n "$DATA_ROLLBACK" ]]; then
    remove_tree "$DATA_ROLLBACK" "$data_parent" 2>/dev/null || true
  fi
}

validate_managed_path() {
  local label="$1" value="$2" component current=""
  local -a components
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ && "$value" =~ ^/[^/]+/[^/]+ ]] \
    || fail "$label doit être un sous-répertoire absolu dédié"
  [[
    "$value" != *"/../"*
    && "$value" != */..
    && "$value" != *"/./"*
    && "$value" != */.
  ]] || fail "$label contient un chemin non sûr"
  IFS='/' read -r -a components <<<"$value"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || fail "$label traverse un lien symbolique: $current"
  done
}

wait_for_postgres() {
  local ready=0
  for _ in $(seq 1 60); do
    if "$COMPOSE_COMMAND" exec -T postgres \
      pg_isready --username=roomframe --dbname=postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]]
}

wait_for_stack() {
  local service_name container_id status all_healthy
  for _ in $(seq 1 90); do
    all_healthy=1
    for service_name in postgres api worker update-poller caddy; do
      container_id="$("$COMPOSE_COMMAND" ps -q "$service_name" 2>/dev/null || true)"
      if [[ -z "$container_id" ]]; then
        all_healthy=0
        break
      fi
      status="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "$container_id" 2>/dev/null || true
      )"
      if [[ "$service_name" == "caddy" ]]; then
        [[ "$status" == "running" ]] || all_healthy=0
      else
        [[ "$status" == "healthy" ]] || all_healthy=0
      fi
    done
    [[ "$all_healthy" -eq 1 ]] && return 0
    sleep 1
  done
  return 1
}

set_database_role_password() {
  "$COMPOSE_COMMAND" exec -T postgres \
    psql \
      --username=roomframe \
      --dbname=postgres \
      --set ON_ERROR_STOP=1 \
      --quiet <<'SQL'
SELECT format(
  'ALTER ROLE roomframe PASSWORD %L',
  trim(pg_read_file('/run/secrets/postgres_password'))
)
\gexec
SQL
}

rollback_restore() {
  local index child failed_path rollback_ok=1
  ROLLBACK_RUNNING=1
  trap - ERR
  printf '%s\n' "Échec détecté; retour automatique à l'état précédent…" >&2

  if [[ -r "$RUNTIME_CONFIG" ]]; then
    "$COMPOSE_COMMAND" down --remove-orphans >/dev/null 2>&1 || rollback_ok=0
  fi

  if [[ "$DATABASE_SWAPPED" -eq 1 ]]; then
    "$COMPOSE_COMMAND" up -d postgres >/dev/null 2>&1 || rollback_ok=0
    if wait_for_postgres; then
      "$COMPOSE_COMMAND" exec -T postgres \
        psql --username=roomframe --dbname=postgres --set ON_ERROR_STOP=1 --quiet \
        --set=restored_name="$DATABASE_TEMP" \
        --set=previous_name="$DATABASE_PREVIOUS" <<'SQL' || rollback_ok=0
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN ('roomframe', :'previous_name')
  AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE roomframe RENAME TO %I', :'restored_name') \gexec
SELECT format('ALTER DATABASE %I RENAME TO roomframe', :'previous_name') \gexec
SQL
      DATABASE_SWAPPED=0
    else
      rollback_ok=0
    fi
  fi

  for ((index=${#DATA_SWAPPED[@]} - 1; index >= 0; index--)); do
    child="${DATA_SWAPPED[$index]}"
    failed_path="$DATA_STAGE/failed-$child"
    if [[ -e "$DATA_DIR/$child" ]]; then
      mv "$DATA_DIR/$child" "$failed_path" || rollback_ok=0
    fi
    if [[ -e "$DATA_ROLLBACK/$child" ]]; then
      mv "$DATA_ROLLBACK/$child" "$DATA_DIR/$child" || rollback_ok=0
    fi
  done
  DATA_SWAPPED=()

  if [[ "$CONFIG_SWAPPED" -eq 1 ]]; then
    if [[ -e "$CONFIG_DIR" ]]; then
      mv "$CONFIG_DIR" "$CONFIG_STAGE/failed-configuration" || rollback_ok=0
    fi
    if [[ -e "$CONFIG_STAGE/previous-configuration" ]]; then
      mv "$CONFIG_STAGE/previous-configuration" "$CONFIG_DIR" || rollback_ok=0
    fi
    CONFIG_SWAPPED=0
  fi

  if [[ "$rollback_ok" -eq 1 ]]; then
    "$COMPOSE_COMMAND" down --remove-orphans >/dev/null 2>&1 || rollback_ok=0
    "$COMPOSE_COMMAND" up -d postgres >/dev/null 2>&1 || rollback_ok=0
    if [[ "$rollback_ok" -eq 1 ]] && wait_for_postgres; then
      set_database_role_password >/dev/null 2>&1 || rollback_ok=0
      if [[ -n "$DATABASE_TEMP" ]]; then
        "$COMPOSE_COMMAND" exec -T postgres \
          dropdb --username=roomframe --if-exists "$DATABASE_TEMP" >/dev/null 2>&1 \
          || rollback_ok=0
      fi
      "$COMPOSE_COMMAND" up -d --no-build --force-recreate --remove-orphans >/dev/null 2>&1 \
        || rollback_ok=0
      if [[ "$rollback_ok" -eq 1 ]]; then
        wait_for_stack || rollback_ok=0
      fi
    else
      rollback_ok=0
    fi
  fi

  if [[ "$rollback_ok" -eq 1 ]]; then
    printf 'État précédent rétabli. Sauvegarde de sécurité: %s\n' "$SAFETY_BACKUP" >&2
  else
    printf '%s\n' \
      "Le retour automatique n'a pas pu être confirmé. Conservez la sauvegarde de sécurité: $SAFETY_BACKUP" >&2
  fi
}

while (($#)); do
  case "$1" in
    --confirm)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      CONFIRMATION="$2"
      shift 2
      ;;
    --latest)
      printf '%s\n' "--latest est volontairement interdit pour une restauration." >&2
      exit 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf 'Option inconnue: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [[ -z "$BACKUP_DIRECTORY" ]] || {
        printf '%s\n' "Un seul répertoire de sauvegarde est accepté." >&2
        exit 2
      }
      BACKUP_DIRECTORY="$1"
      shift
      ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ -n "$BACKUP_DIRECTORY" && -n "$CONFIRMATION" ]] || {
  usage >&2
  exit 2
}
[[ -r "$RUNTIME_CONFIG" ]] || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"
BACKUP_COMMAND="${ROOMFRAME_BACKUP_COMMAND:-$INSTALL_DIR/scripts/roomframe-backup.sh}"
VERIFY_COMMAND="${ROOMFRAME_VERIFY_BACKUP_COMMAND:-$INSTALL_DIR/scripts/roomframe-verify-backup.sh}"
BACKUP_ROOT="$DATA_DIR/backups"

validate_managed_path ROOMFRAME_CONFIG_DIR "$CONFIG_DIR"
validate_managed_path ROOMFRAME_DATA_DIR "$DATA_DIR"
validate_managed_path ROOMFRAME_INSTALL_DIR "$INSTALL_DIR"
[[ -x "$COMPOSE_COMMAND" && -x "$BACKUP_COMMAND" && -x "$VERIFY_COMMAND" ]] \
  || fail "commandes d'exploitation RoomFrame incomplètes"
command -v docker >/dev/null 2>&1 || fail "Docker est introuvable"
docker info >/dev/null 2>&1 || fail "le démon Docker ne répond pas"

mkdir -p /run/lock
if [[ "${ROOMFRAME_MAINTENANCE_LOCK_HELD:-0}" != "1" ]]; then
  exec 9>"${ROOMFRAME_MAINTENANCE_LOCK_FILE:-/run/lock/roomframe-install.lock}"
  flock -n 9 || fail "une autre opération de maintenance RoomFrame est active"
fi

[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] \
  || fail "répertoire de sauvegardes invalide"
BACKUP_ROOT_REAL="$(realpath -e "$BACKUP_ROOT")"
BACKUP_REAL="$(realpath -e "$BACKUP_DIRECTORY")"
[[ "$(dirname "$BACKUP_REAL")" == "$BACKUP_ROOT_REAL" ]] \
  || fail "la sauvegarde doit être un enfant direct de $BACKUP_ROOT_REAL"
RESTORE_ID="$(basename "$BACKUP_REAL")"
[[ "$RESTORE_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  || fail "identifiant de sauvegarde invalide"
[[ "$CONFIRMATION" == "$RESTORE_ID" ]] \
  || fail "--confirm doit reprendre exactement l'identifiant $RESTORE_ID"

printf '%s\n' "Vérification isolée de la sauvegarde $RESTORE_ID…"
"$VERIFY_COMMAND" "$BACKUP_REAL"

CURRENT_VERSION="${ROOMFRAME_VERSION:-unknown}"
python3 - "$BACKUP_REAL/metadata.json" "$CURRENT_VERSION" <<'PY'
import json
import pathlib
import sys

metadata = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if metadata.get("includesMedia") is not True:
    raise SystemExit("une restauration complète exige une sauvegarde contenant les médias")
if metadata.get("softwareVersion") != sys.argv[2]:
    raise SystemExit(
        "version incompatible: sauvegarde "
        f"{metadata.get('softwareVersion')!r}, installation {sys.argv[2]!r}"
    )
PY

CONFIG_PARENT="$(dirname "$CONFIG_DIR")"
CONFIG_BASENAME="$(basename "$CONFIG_DIR")"
CONFIG_STAGE="$(mktemp -d "$CONFIG_PARENT/.roomframe-restore.XXXXXX")"
DATA_STAGE="$(mktemp -d "$DATA_DIR/.restore-stage.XXXXXX")"
DATA_ROLLBACK="$(mktemp -d "$DATA_DIR/.restore-rollback.XXXXXX")"
chmod 0700 "$CONFIG_STAGE" "$DATA_STAGE" "$DATA_ROLLBACK"

python3 - \
  "$BACKUP_REAL/configuration.tar.gz" \
  "$BACKUP_REAL/persistent-data.tar.gz" \
  "$CONFIG_BASENAME" <<'PY'
import pathlib
import sys
import tarfile

configuration, persistent, expected_config_root = map(pathlib.Path, sys.argv[1:])
allowed_data_roots = {
    "app",
    "caddy",
    "caddy-config",
    "media",
    "pki",
    "releases",
    "seed",
}

with tarfile.open(configuration, "r:gz") as archive:
    roots = {
        pathlib.PurePosixPath(member.name).parts[0]
        for member in archive.getmembers()
        if pathlib.PurePosixPath(member.name).parts
    }
    if roots != {expected_config_root.name}:
        raise SystemExit("racine de l'archive de configuration incompatible")

seen_data_roots = set()
with tarfile.open(persistent, "r:gz") as archive:
    for member in archive.getmembers():
        parts = [
            part for part in pathlib.PurePosixPath(member.name).parts
            if part not in {".", ""}
        ]
        if not parts:
            continue
        root = parts[0]
        if root not in allowed_data_roots:
            raise SystemExit(f"racine persistante inattendue: {root}")
        seen_data_roots.add(root)
if "media" not in seen_data_roots:
    raise SystemExit("répertoire media absent de la sauvegarde complète")
PY

tar --no-same-owner -xzf "$BACKUP_REAL/configuration.tar.gz" -C "$CONFIG_STAGE"
mkdir -p "$DATA_STAGE/candidate"
tar --no-same-owner -xzf "$BACKUP_REAL/persistent-data.tar.gz" -C "$DATA_STAGE/candidate"

RESTORED_CONFIG="$CONFIG_STAGE/$CONFIG_BASENAME"
[[ -d "$RESTORED_CONFIG" && ! -L "$RESTORED_CONFIG" ]] \
  || fail "configuration restaurée absente"
[[ -f "$RESTORED_CONFIG/runtime.conf" && ! -L "$RESTORED_CONFIG/runtime.conf" ]] \
  || fail "runtime.conf absent de la sauvegarde"

python3 - \
  "$RESTORED_CONFIG/runtime.conf" \
  "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR" \
  "${ROOMFRAME_RUNTIME_UID:-}" "${ROOMFRAME_RUNTIME_GID:-}" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
expected = {
    "ROOMFRAME_INSTALL_DIR": sys.argv[2],
    "ROOMFRAME_CONFIG_DIR": sys.argv[3],
    "ROOMFRAME_DATA_DIR": sys.argv[4],
    "ROOMFRAME_RUNTIME_UID": sys.argv[5],
    "ROOMFRAME_RUNTIME_GID": sys.argv[6],
}
values = {}
pattern = re.compile(r"^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_+:/.,@-]*)$")
for line in path.read_text(encoding="utf-8").splitlines():
    match = pattern.fullmatch(line)
    if not match or match.group(1) in values:
        raise SystemExit("runtime.conf restauré invalide")
    values[match.group(1)] = match.group(2)
for key, value in expected.items():
    if not value or values.get(key) != value:
        raise SystemExit(f"runtime.conf incompatible pour {key}")
PY

for secret_name in postgres_password bootstrap_token session_secret totp_encryption_key; do
  secret_path="$RESTORED_CONFIG/secrets/$secret_name"
  [[ -f "$secret_path" && ! -L "$secret_path" && -s "$secret_path" ]] \
    || fail "secret restauré absent ou invalide: $secret_name"
done

printf '%s\n' "Création du point de retour de l'état courant…"
backup_output="$(
  ROOMFRAME_MAINTENANCE_LOCK_HELD=1 "$BACKUP_COMMAND"
)"
printf '%s\n' "$backup_output"
SAFETY_BACKUP="$(
  sed -n 's/^Sauvegarde terminée: //p' <<<"$backup_output" | tail -n 1
)"
[[ -n "$SAFETY_BACKUP" && -d "$SAFETY_BACKUP" ]] \
  || fail "la sauvegarde de sécurité n'a pas produit de chemin exploitable"
"$VERIFY_COMMAND" "$SAFETY_BACKUP"

printf '%s\n' "Arrêt contrôlé des services RoomFrame…"
"$COMPOSE_COMMAND" down --remove-orphans

mv "$CONFIG_DIR" "$CONFIG_STAGE/previous-configuration"
CONFIG_SWAPPED=1
mv "$RESTORED_CONFIG" "$CONFIG_DIR"

for child in app caddy caddy-config media pki releases seed; do
  restored_child="$DATA_STAGE/candidate/$child"
  [[ -e "$restored_child" && ! -L "$restored_child" ]] || continue
  if [[ -e "$DATA_DIR/$child" ]]; then
    mv "$DATA_DIR/$child" "$DATA_ROLLBACK/$child"
  fi
  DATA_SWAPPED+=("$child")
  mv "$restored_child" "$DATA_DIR/$child"
done

if [[ -e "$DATA_DIR/processing" ]]; then
  mv "$DATA_DIR/processing" "$DATA_ROLLBACK/processing"
fi
DATA_SWAPPED+=("processing")
mkdir "$DATA_DIR/processing"

ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$INSTALL_DIR/defaults/experience" \
ROOMFRAME_RUNTIME_UID="${ROOMFRAME_RUNTIME_UID}" \
ROOMFRAME_RUNTIME_GID="${ROOMFRAME_RUNTIME_GID}" \
  "$INSTALL_DIR/scripts/bootstrap.sh"

DATABASE_TEMP="roomframe_restore_${RANDOM}_$$"
DATABASE_PREVIOUS="roomframe_before_restore_${RANDOM}_$$"

"$COMPOSE_COMMAND" up -d postgres
wait_for_postgres || fail "PostgreSQL n'est pas devenu disponible"

"$COMPOSE_COMMAND" exec -T postgres \
  createdb --username=roomframe "$DATABASE_TEMP"
"$COMPOSE_COMMAND" exec -T postgres \
  pg_restore \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges \
    --username=roomframe \
    --dbname="$DATABASE_TEMP" \
    <"$BACKUP_REAL/postgres.dump" >/dev/null

database_check="$(
  "$COMPOSE_COMMAND" exec -T postgres \
    psql \
      --username=roomframe \
      --dbname="$DATABASE_TEMP" \
      --tuples-only \
      --no-align \
      --set ON_ERROR_STOP=1 \
      --command "
        SELECT
          (SELECT count(*) > 0 FROM schema_migrations)
          AND to_regclass('public.roomframe_instance') IS NOT NULL
          AND to_regclass('public.scenes') IS NOT NULL
          AND to_regclass('public.media_jobs') IS NOT NULL;
      "
)"
[[ "$database_check" == "t" ]] \
  || fail "contrôle d'intégrité négatif dans la base restaurée"

"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=postgres --set ON_ERROR_STOP=1 --quiet \
  --set=restored_name="$DATABASE_TEMP" \
  --set=previous_name="$DATABASE_PREVIOUS" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN ('roomframe', :'restored_name')
  AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE roomframe RENAME TO %I', :'previous_name') \gexec
SELECT format('ALTER DATABASE %I RENAME TO roomframe', :'restored_name') \gexec
SQL
DATABASE_SWAPPED=1

set_database_role_password
"$COMPOSE_COMMAND" up -d --no-build --force-recreate --remove-orphans
wait_for_stack || fail "la pile restaurée n'est pas devenue saine"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a
curl -kfsS --connect-timeout 3 \
  --resolve "${ROOMFRAME_PRIMARY_HOST}:443:127.0.0.1" \
  "${ROOMFRAME_PREFERRED_URL}/health" >/dev/null \
  || fail "le contrôle HTTPS final a échoué"

"$COMPOSE_COMMAND" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
  --set=restore_id="$RESTORE_ID" \
  --set=safety_backup="$SAFETY_BACKUP" <<'SQL'
INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'system',
  'backup.restored',
  'backup',
  :'restore_id',
  jsonb_build_object('safetyBackup', :'safety_backup')
);
SQL

"$COMPOSE_COMMAND" exec -T postgres \
  dropdb --username=roomframe --if-exists "$DATABASE_PREVIOUS"
DATABASE_SWAPPED=0

cleanup_staging
trap - ERR HUP INT TERM

printf '\n%s\n' "Restauration terminée et contrôlée."
printf 'Sauvegarde restaurée : %s\n' "$BACKUP_REAL"
printf 'Point de retour créé : %s\n' "$SAFETY_BACKUP"
