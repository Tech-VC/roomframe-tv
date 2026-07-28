#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
RELEASE_ID=""
CONFIRM_VERSION=""
STAGE=""
CANDIDATE=""
CODE_ROLLBACK=""
SAFETY_BACKUP=""
CODE_ARCHIVE=""
CODE_SWAPPED=0
ROLLBACK_RUNNING=0
DATA_DIR=""
INSTALL_DIR=""
COMPOSE_COMMAND=""
RELEASE_VERSION=""

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-apply-update \
    --release-id 00000000-0000-4000-8000-000000000000 \
    --confirm 0.3.1

Applique l'archive serveur d'une release déjà importée et vérifiée :
  1. relit la release dans PostgreSQL et revalide SHA-256 + Ed25519 ;
  2. contrôle et extrait l'archive serveur dans un staging root-only ;
  3. préconstruit les images sans interrompre l'instance ;
  4. crée et vérifie une sauvegarde complète ;
  5. bascule le code, exécute l'installateur idempotent et les migrations ;
  6. revient au code précédent si le healthcheck échoue.

Cette commande root n'est jamais appelée directement par l'API web. Elle
n'accepte ni chemin de bundle arbitraire, ni clé privée, ni downgrade.
USAGE
}

cleanup_stage() {
  [[ -n "$STAGE" && -d "$STAGE" && ! -L "$STAGE" ]] || return 0
  [[ "$(dirname "$STAGE")" == "$(dirname "$INSTALL_DIR")" ]] || return 1
  find "$STAGE" -xdev -depth -mindepth 1 -delete
  rmdir "$STAGE"
}

write_state() {
  local status="$1" message="$2"
  python3 - \
    "$DATA_DIR/app/server-update-state.json" \
    "$RELEASE_ID" "${RELEASE_VERSION:-}" "$status" "$message" \
    "$SAFETY_BACKUP" "$CODE_ARCHIVE" <<'PY'
import json
import os
import pathlib
import sys
import tempfile
from datetime import datetime, timezone

path = pathlib.Path(sys.argv[1])
document = {
    "schemaVersion": 1,
    "releaseId": sys.argv[2] or None,
    "version": sys.argv[3] or None,
    "status": sys.argv[4],
    "message": sys.argv[5],
    "safetyBackup": sys.argv[6] or None,
    "codeRollbackArchive": sys.argv[7] or None,
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
path.parent.mkdir(parents=True, exist_ok=True)
descriptor, temporary = tempfile.mkstemp(
    prefix=".server-update-state.",
    dir=path.parent,
    text=True,
)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
  chown root:root "$DATA_DIR/app/server-update-state.json"
}

audit_event() {
  local action="$1" result="$2"
  "$COMPOSE_COMMAND" exec -T postgres \
    psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
    --set=release_id="$RELEASE_ID" \
    --set=version="$RELEASE_VERSION" \
    --set=result="$result" \
    --set=safety_backup="$SAFETY_BACKUP" <<SQL
INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'system',
  '$action',
  'release',
  :'release_id',
  jsonb_build_object(
    'version', :'version',
    'result', :'result',
    'safetyBackup', NULLIF(:'safety_backup', '')
  )
);
SQL
}

install_arguments() {
  INSTALL_ARGS=(
    --source "$INSTALL_DIR"
    --host "$CURRENT_PRIMARY_HOST"
  )
  if [[ -n "$CURRENT_UPDATE_REPOSITORY" ]]; then
    INSTALL_ARGS+=(
      --updates-repository "$CURRENT_UPDATE_REPOSITORY"
      --updates-channel "$CURRENT_UPDATE_CHANNEL"
      --update-poll-minutes "$CURRENT_UPDATE_POLL_MINUTES"
    )
  else
    INSTALL_ARGS+=(--disable-github-updates)
  fi
}

rollback_code() {
  local failed_code="$STAGE/failed-code"
  ROLLBACK_RUNNING=1
  trap - ERR HUP INT TERM
  printf '%s\n' "Échec de mise à jour; retour au code précédent…" >&2

  if [[ -x "$INSTALL_DIR/scripts/roomframe-compose.sh" ]]; then
    "$INSTALL_DIR/scripts/roomframe-compose.sh" down --remove-orphans \
      >/dev/null 2>&1 || true
  fi

  if [[ -d "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]]; then
    mv "$INSTALL_DIR" "$failed_code" || return 1
  fi
  [[ -d "$CODE_ROLLBACK" && ! -L "$CODE_ROLLBACK" ]] || return 1
  mv "$CODE_ROLLBACK" "$INSTALL_DIR" || return 1
  CODE_SWAPPED=0

  install_arguments
  ROOMFRAME_MAINTENANCE_LOCK_HELD=1 \
  ROOMFRAME_PREVERIFIED_BACKUP="$SAFETY_BACKUP" \
    "$INSTALL_DIR/install.sh" "${INSTALL_ARGS[@]}" || return 1

  audit_event 'release.server_apply_rolled_back' 'code-restored' \
    >/dev/null 2>&1 || true
  write_state rolled-back "Le healthcheck a échoué; le code précédent a été rétabli." \
    >/dev/null 2>&1 || true
  cleanup_stage || true
  printf 'Code précédent rétabli. Point de retour: %s\n' "$SAFETY_BACKUP" >&2
  return 0
}

fail() {
  local message="$*"
  trap - ERR HUP INT TERM
  printf 'Mise à jour serveur refusée: %s\n' "$message" >&2
  if [[ "$CODE_SWAPPED" -eq 1 && "$ROLLBACK_RUNNING" -eq 0 ]]; then
    if ! rollback_code; then
      write_state failed \
        "Échec de mise à jour et retour automatique non confirmé." \
        >/dev/null 2>&1 || true
      printf 'Retour automatique non confirmé. Point de retour: %s\n' \
        "$SAFETY_BACKUP" >&2
    fi
  else
    if [[ -n "$DATA_DIR" && -d "$DATA_DIR/app" ]]; then
      write_state failed "$message" >/dev/null 2>&1 || true
    fi
    cleanup_stage || true
    if [[ -n "$SAFETY_BACKUP" ]]; then
      printf 'Point de retour conservé: %s\n' "$SAFETY_BACKUP" >&2
    fi
  fi
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

while (($#)); do
  case "$1" in
    --release-id)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      RELEASE_ID="$2"
      shift 2
      ;;
    --confirm)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      CONFIRM_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Option inconnue: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ "$RELEASE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "--release-id doit être un UUID canonique en minuscules"
[[ "$CONFIRM_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
  || fail "--confirm doit contenir la version SemVer attendue"
[[ -r "$RUNTIME_CONFIG" ]] || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
COMPOSE_COMMAND="${ROOMFRAME_COMPOSE_COMMAND:-$INSTALL_DIR/scripts/roomframe-compose.sh}"
BACKUP_COMMAND="${ROOMFRAME_BACKUP_COMMAND:-$INSTALL_DIR/scripts/roomframe-backup.sh}"
VERIFY_BACKUP_COMMAND="${ROOMFRAME_VERIFY_BACKUP_COMMAND:-$INSTALL_DIR/scripts/roomframe-verify-backup.sh}"
VERIFY_UPDATE_COMMAND="${ROOMFRAME_VERIFY_UPDATE_COMMAND:-$INSTALL_DIR/scripts/verify-update-bundle.py}"
CURRENT_VERSION="${ROOMFRAME_VERSION:-}"
CURRENT_PRIMARY_HOST="${ROOMFRAME_PRIMARY_HOST:-}"
CURRENT_UPDATE_REPOSITORY="${ROOMFRAME_UPDATE_GITHUB_REPOSITORY:-}"
CURRENT_UPDATE_CHANNEL="${ROOMFRAME_UPDATE_GITHUB_CHANNEL:-stable}"
CURRENT_UPDATE_POLL_MINUTES="${ROOMFRAME_UPDATE_POLL_MINUTES:-360}"

[[
  "$INSTALL_DIR" =~ ^/[^/]+/[^/]+
  && "$DATA_DIR" =~ ^/[^/]+/[^/]+
  && -d "$INSTALL_DIR"
  && ! -L "$INSTALL_DIR"
  && -d "$DATA_DIR"
  && ! -L "$DATA_DIR"
]] || fail "répertoires gérés invalides ou symboliques"
[[ -x "$COMPOSE_COMMAND" && -x "$BACKUP_COMMAND" && -x "$VERIFY_BACKUP_COMMAND" ]] \
  || fail "commandes d'exploitation incomplètes"
[[ -f "$VERIFY_UPDATE_COMMAND" && ! -L "$VERIFY_UPDATE_COMMAND" ]] \
  || fail "vérificateur de release absent ou symbolique"
[[ -n "$CURRENT_VERSION" && -n "$CURRENT_PRIMARY_HOST" ]] \
  || fail "runtime.conf incomplet"
command -v docker >/dev/null 2>&1 || fail "Docker est introuvable"
docker info >/dev/null 2>&1 || fail "le démon Docker ne répond pas"

mkdir -p /run/lock
exec 9>"${ROOMFRAME_MAINTENANCE_LOCK_FILE:-/run/lock/roomframe-install.lock}"
flock -n 9 || fail "une autre opération de maintenance RoomFrame est active"

release_row="$(
  "$COMPOSE_COMMAND" exec -T postgres \
    psql \
      --username=roomframe \
      --dbname=roomframe \
      --tuples-only \
      --no-align \
      --field-separator=$'\t' \
      --set ON_ERROR_STOP=1 \
      --set=release_id="$RELEASE_ID" \
      --command "
        SELECT version, status, sha256, signature_key_id, storage_path
        FROM release_history
        WHERE id = :'release_id'::uuid;
      "
)"
[[ -n "$release_row" && "$(wc -l <<<"$release_row" | tr -d ' ')" == "1" ]] \
  || fail "release importée introuvable ou ambiguë"
IFS=$'\t' read -r RELEASE_VERSION RELEASE_STATUS RELEASE_SHA RELEASE_KEY_ID RELEASE_PATH \
  <<<"$release_row"

[[ "$RELEASE_STATUS" == "verified" ]] \
  || fail "la release doit avoir le statut verified"
[[ "$RELEASE_VERSION" == "$CONFIRM_VERSION" ]] \
  || fail "--confirm ne correspond pas à la release $RELEASE_VERSION"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{64}$ ]] \
  || fail "SHA-256 de release invalide en base"
[[ "$RELEASE_KEY_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] \
  || fail "identifiant de clé invalide en base"

VERIFIED_ROOT="$DATA_DIR/releases/verified"
[[ -d "$VERIFIED_ROOT" && ! -L "$VERIFIED_ROOT" ]] \
  || fail "quarantaine de releases absente ou symbolique"
VERIFIED_ROOT_REAL="$(realpath -e "$VERIFIED_ROOT")"
RELEASE_REAL="$(realpath -e "$RELEASE_PATH")"
[[
  "$(dirname "$RELEASE_REAL")" == "$VERIFIED_ROOT_REAL"
  && "$(basename "$RELEASE_REAL")" == "$RELEASE_SHA.rfupdate"
  && -f "$RELEASE_REAL"
  && ! -L "$RELEASE_REAL"
]] || fail "chemin de release hors de la quarantaine attendue"
[[ "$(sha256sum "$RELEASE_REAL" | awk '{print $1}')" == "$RELEASE_SHA" ]] \
  || fail "SHA-256 du bundle différent de l'historique"

TRUST_KEY="$DATA_DIR/pki/update-trust/$RELEASE_KEY_ID.pem"
[[ -f "$TRUST_KEY" && ! -L "$TRUST_KEY" ]] \
  || fail "clé publique approuvée absente: $RELEASE_KEY_ID"

printf '%s\n' "Nouvelle vérification Ed25519 de la release $RELEASE_VERSION…"
python3 "$VERIFY_UPDATE_COMMAND" \
  "$RELEASE_REAL" \
  --trust-key "$TRUST_KEY" \
  --current-version "$CURRENT_VERSION"

INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
STAGE="$(mktemp -d "$INSTALL_PARENT/.roomframe-apply.XXXXXX")"
chmod 0700 "$STAGE"
CANDIDATE="$STAGE/candidate"
CODE_ROLLBACK="$STAGE/previous-code"
mkdir "$CANDIDATE"

python3 - \
  "$RELEASE_REAL" "$STAGE/server.tar.gz" \
  "$RELEASE_ID" "$RELEASE_VERSION" "$RELEASE_KEY_ID" <<'PY'
import json
import os
import pathlib
import sys
import zipfile

bundle = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
expected_id, expected_version, expected_key = sys.argv[3:]

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SystemExit(f"clé JSON dupliquée: {key}")
        result[key] = value
    return result

with zipfile.ZipFile(bundle) as archive:
    manifest = json.loads(
        archive.read("manifest.json").decode("utf-8"),
        object_pairs_hook=unique_object,
    )
    if (
        manifest.get("releaseId") != expected_id
        or manifest.get("version") != expected_version
        or manifest.get("signature", {}).get("keyId") != expected_key
    ):
        raise SystemExit("identité du manifeste différente de l'historique")
    server_artifacts = [
        artifact
        for artifact in manifest.get("artifacts", [])
        if artifact.get("kind") == "server-archive"
    ]
    if len(server_artifacts) != 1:
        raise SystemExit("la release doit contenir exactement une archive serveur")
    artifact = server_artifacts[0]
    info = archive.getinfo(artifact["path"])
    with archive.open(info) as source, destination.open("xb") as target:
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
os.chmod(destination, 0o600)
PY

python3 - "$STAGE/server.tar.gz" "$CANDIDATE" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2]).resolve()
members = []
seen = set()
total_size = 0
with tarfile.open(archive_path, "r:gz") as archive:
    for member in archive.getmembers():
        name = member.name
        while name.startswith("./"):
            name = name[2:]
        if name in {"", "."} and member.isdir():
            continue
        path = pathlib.PurePosixPath(name)
        if (
            path.is_absolute()
            or not path.parts
            or any(part in {"", ".", ".."} for part in path.parts)
            or path.as_posix() in seen
            or not (member.isfile() or member.isdir())
        ):
            raise SystemExit(f"entrée d'archive serveur non sûre: {member.name!r}")
        seen.add(path.as_posix())
        total_size += member.size
        if total_size > 2 * 1024 * 1024 * 1024:
            raise SystemExit("archive serveur décompressée trop volumineuse")
        target = (destination / pathlib.Path(*path.parts)).resolve()
        if destination not in target.parents and target != destination:
            raise SystemExit("sortie d'archive serveur interdite")
        member.name = path.as_posix()
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
        members.append(member)
    archive.extractall(destination, members=members)
PY

python3 - "$CANDIDATE" "$RELEASE_VERSION" "$RELEASE_REAL" <<'PY'
import json
import pathlib
import re
import sys
import zipfile

candidate = pathlib.Path(sys.argv[1])
expected_version = sys.argv[2]
bundle = pathlib.Path(sys.argv[3])
required = [
    "install.sh",
    "compose.yaml",
    "infra/Caddyfile",
    "scripts/source-excludes.txt",
    "scripts/roomframe-apply-update.sh",
    "services/api/package.json",
    "defaults/experience/manifest.json",
]
for relative in required:
    path = candidate / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"fichier serveur requis absent: {relative}")

install_text = (candidate / "install.sh").read_text(encoding="utf-8")
match = re.search(r'^ROOMFRAME_VERSION="([^"]+)"$', install_text, re.MULTILINE)
if not match or match.group(1) != expected_version:
    raise SystemExit("version de install.sh différente du manifeste")
package = json.loads(
    (candidate / "services/api/package.json").read_text(encoding="utf-8")
)
if package.get("version") != expected_version:
    raise SystemExit("version du service API différente du manifeste")

with zipfile.ZipFile(bundle) as archive:
    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
expected_migrations = set(manifest.get("migrations", []))
actual_migrations = {
    path.stem for path in (candidate / "database/migrations").glob("*.sql")
}
if expected_migrations != actual_migrations:
    raise SystemExit("liste des migrations différente du manifeste signé")
PY

printf '%s\n' "Préconstruction des images de la release…"
export COMPOSE_DISABLE_ENV_FILE=1
if docker compose version >/dev/null 2>&1; then
  ROOMFRAME_VERSION="$RELEASE_VERSION" \
  ROOMFRAME_INSTALL_DIR="$CANDIDATE" \
    docker compose --env-file /dev/null -f "$CANDIDATE/compose.yaml" \
      build api worker update-poller
elif command -v docker-compose >/dev/null 2>&1; then
  ROOMFRAME_VERSION="$RELEASE_VERSION" \
  ROOMFRAME_INSTALL_DIR="$CANDIDATE" \
    docker-compose --env-file /dev/null -f "$CANDIDATE/compose.yaml" \
      build api worker update-poller
else
  fail "Docker Compose est introuvable"
fi

printf '%s\n' "Création et vérification du point de retour…"
backup_output="$(
  ROOMFRAME_MAINTENANCE_LOCK_HELD=1 "$BACKUP_COMMAND"
)"
printf '%s\n' "$backup_output"
SAFETY_BACKUP="$(
  sed -n 's/^Sauvegarde terminée: //p' <<<"$backup_output" | tail -n 1
)"
[[ -n "$SAFETY_BACKUP" && -d "$SAFETY_BACKUP" ]] \
  || fail "la sauvegarde de sécurité n'a pas produit de chemin exploitable"
"$VERIFY_BACKUP_COMMAND" "$SAFETY_BACKUP"

write_state applying "Release vérifiée; bascule du code en cours."
audit_event 'release.server_apply_started' 'applying'

printf '%s\n' "Bascule contrôlée du code serveur…"
"$COMPOSE_COMMAND" down --remove-orphans
mv "$INSTALL_DIR" "$CODE_ROLLBACK"
CODE_SWAPPED=1
mv "$CANDIDATE" "$INSTALL_DIR"

install_arguments
ROOMFRAME_MAINTENANCE_LOCK_HELD=1 \
ROOMFRAME_PREVERIFIED_BACKUP="$SAFETY_BACKUP" \
  "$INSTALL_DIR/install.sh" "${INSTALL_ARGS[@]}"

ROLLBACK_ROOT="$DATA_DIR/app/server-rollbacks"
mkdir -p "$ROLLBACK_ROOT"
chmod 0700 "$ROLLBACK_ROOT"
chown root:root "$ROLLBACK_ROOT"
CODE_ARCHIVE="$ROLLBACK_ROOT/${CURRENT_VERSION}-before-${RELEASE_VERSION}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
archive_temporary="$ROLLBACK_ROOT/.code-rollback.$$.tar.gz"
tar -C "$CODE_ROLLBACK" -czf "$archive_temporary" .
chmod 0600 "$archive_temporary"
chown root:root "$archive_temporary"
mv "$archive_temporary" "$CODE_ARCHIVE"
CODE_ARCHIVE_SHA="$(sha256sum "$CODE_ARCHIVE" | awk '{print $1}')"

"$INSTALL_DIR/scripts/roomframe-compose.sh" exec -T postgres \
  psql --username=roomframe --dbname=roomframe --set ON_ERROR_STOP=1 --quiet \
  --set=release_id="$RELEASE_ID" \
  --set=version="$RELEASE_VERSION" \
  --set=safety_backup="$SAFETY_BACKUP" \
  --set=code_archive="$CODE_ARCHIVE" \
  --set=code_sha="$CODE_ARCHIVE_SHA" <<'SQL'
UPDATE release_history
SET deployed_at = now()
WHERE id = :'release_id'::uuid
  AND version = :'version'
  AND status = 'verified';

INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
) VALUES (
  'system',
  'release.server_apply_completed',
  'release',
  :'release_id',
  jsonb_build_object(
    'version', :'version',
    'safetyBackup', :'safety_backup',
    'codeRollbackArchive', :'code_archive',
    'codeRollbackSha256', :'code_sha'
  )
);
SQL

CODE_SWAPPED=0
write_state completed "Release appliquée; healthchecks réussis."
cleanup_stage
trap - ERR HUP INT TERM

printf '\n%s\n' "Mise à jour serveur appliquée et contrôlée."
printf 'Release              : %s (%s)\n' "$RELEASE_VERSION" "$RELEASE_ID"
printf 'Point de retour      : %s\n' "$SAFETY_BACKUP"
printf 'Archive ancien code  : %s\n' "$CODE_ARCHIVE"
