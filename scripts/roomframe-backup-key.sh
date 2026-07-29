#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
ACTION=""
EXPORT_PATH=""

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-backup-key --show-recipient
  sudo roomframe-backup-key --export-identity /chemin/hors-ligne/roomframe-backup.agekey

Affiche uniquement la clé publique de chiffrement ou exporte explicitement
l'identité privée root-only nécessaire à une reprise après perte du serveur.
La commande refuse d'écraser une destination existante.
USAGE
}

fail() {
  printf 'Gestion de la clé de sauvegarde refusée: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --show-recipient)
      [[ -z "$ACTION" ]] || fail "une seule action est acceptée"
      ACTION="show"
      shift
      ;;
    --export-identity)
      [[ -z "$ACTION" && $# -ge 2 ]] || fail "chemin d'export manquant ou action dupliquée"
      ACTION="export"
      EXPORT_PATH="$2"
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

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ -n "$ACTION" ]] || {
  usage >&2
  exit 2
}
[[ -r "$RUNTIME_CONFIG" ]] || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
IDENTITY_FILE="${ROOMFRAME_BACKUP_IDENTITY_FILE:-$CONFIG_DIR/secrets/backup_age_identity}"
[[ -f "$IDENTITY_FILE" && -s "$IDENTITY_FILE" && ! -L "$IDENTITY_FILE" ]] \
  || fail "identité age absente ou invalide"
[[ "$(stat -c '%a:%u:%g' "$IDENTITY_FILE")" == "400:0:0" ]] \
  || fail "l'identité age doit appartenir à root:root en mode 0400"
command -v age-keygen >/dev/null 2>&1 || fail "age-keygen est introuvable"

recipient="$(age-keygen -y "$IDENTITY_FILE" 2>/dev/null)"
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || fail "identité age illisible"

if [[ "$ACTION" == "show" ]]; then
  printf 'Destinataire public age: %s\n' "$recipient"
  exit 0
fi

[[ "$EXPORT_PATH" =~ ^/[^[:cntrl:]]+$ ]] \
  || fail "la destination doit être un chemin absolu"
[[ ! -e "$EXPORT_PATH" && ! -L "$EXPORT_PATH" ]] \
  || fail "la destination existe déjà"
export_parent="$(dirname "$EXPORT_PATH")"
[[ -d "$export_parent" && ! -L "$export_parent" ]] \
  || fail "le répertoire de destination est absent ou symbolique"
export_parent_real="$(realpath -e "$export_parent")"
[[ "$export_parent_real" != "/" ]] \
  || fail "l'export direct à la racine est refusé"

umask 077
python3 - "$IDENTITY_FILE" "$EXPORT_PATH" <<'PY' \
  || fail "la destination existe déjà ou l'export atomique a échoué"
import os
import shutil
import sys

source_path, destination_path = sys.argv[1:]
source_flags = os.O_RDONLY
if hasattr(os, "O_NOFOLLOW"):
    source_flags |= os.O_NOFOLLOW
destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    destination_flags |= os.O_NOFOLLOW

source_fd = os.open(source_path, source_flags)
destination_created = False
try:
    destination_fd = os.open(destination_path, destination_flags, 0o600)
    destination_created = True
    try:
        with os.fdopen(source_fd, "rb", closefd=False) as source:
            with os.fdopen(destination_fd, "wb", closefd=False) as destination:
                shutil.copyfileobj(source, destination)
                destination.flush()
                os.fsync(destination.fileno())
        os.fchmod(destination_fd, 0o600)
        os.fchown(destination_fd, 0, 0)
    finally:
        os.close(destination_fd)
except BaseException:
    if destination_created:
        try:
            os.unlink(destination_path)
        except FileNotFoundError:
            pass
    raise
finally:
    os.close(source_fd)
PY
trap 'rm -f "$EXPORT_PATH"' EXIT
[[ "$(stat -c '%a:%u:%g' "$EXPORT_PATH")" == "600:0:0" ]] \
  || fail "le support ne permet pas de protéger l'identité en mode 0600 root-only"
trap - EXIT

printf 'Identité privée exportée en mode 0600: %s\n' "$EXPORT_PATH"
printf '%s\n' "Conservez cette copie hors ligne; ne la placez jamais dans le dépôt."
