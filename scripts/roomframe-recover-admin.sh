#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
TTL_MINUTES=15
CREATE=0
REPLACE=0

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-recover-admin --create [--ttl-minutes 15] [--replace]

Crée une demande locale temporaire de réinitialisation MFA/mot de passe.
Le jeton clair est affiché une seule fois; seul son SHA-256 est écrit sur disque.
--replace est requis si une demande non consommée existe déjà.
USAGE
}

while (($#)); do
  case "$1" in
    --create) CREATE=1; shift ;;
    --replace) REPLACE=1; shift ;;
    --ttl-minutes)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --ttl-minutes" >&2; exit 2; }
      TTL_MINUTES="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécutez cette commande avec sudo/root." >&2
  exit 1
}
[[ "$CREATE" -eq 1 ]] || {
  usage >&2
  exit 2
}
[[ "$TTL_MINUTES" =~ ^[0-9]+$ ]] && ((TTL_MINUTES >= 5 && TTL_MINUTES <= 60)) || {
  echo "--ttl-minutes doit être compris entre 5 et 60." >&2
  exit 2
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
RUNTIME_GID="${ROOMFRAME_RUNTIME_GID:-}"
[[ "$RUNTIME_GID" =~ ^[0-9]+$ ]] && ((RUNTIME_GID > 0)) || {
  echo "ROOMFRAME_RUNTIME_GID est absent ou invalide dans runtime.conf." >&2
  exit 1
}
REQUEST_FILE="$DATA_DIR/app/recovery/request.json"
token="$(openssl rand -hex 32)"
token_hash="$(printf '%s' "$token" | sha256sum | awk '{print $1}')"

python3 - "$REQUEST_FILE" "$token_hash" "$TTL_MINUTES" "$REPLACE" "$RUNTIME_GID" <<'PY'
import json
import os
import pathlib
import sys
import tempfile
from datetime import datetime, timedelta, timezone

path = pathlib.Path(sys.argv[1])
token_hash = sys.argv[2]
ttl = int(sys.argv[3])
replace = sys.argv[4] == "1"
runtime_gid = int(sys.argv[5])
now = datetime.now(timezone.utc)

if path.exists() and not replace:
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        expires = datetime.fromisoformat(current["expiresAt"].replace("Z", "+00:00"))
        active = current.get("consumedAt") is None and expires > now
    except (KeyError, ValueError, json.JSONDecodeError):
        active = True
    if active:
        raise SystemExit("Une demande active existe déjà; utilisez --replace explicitement.")

request = {
    "tokenHash": token_hash,
    "createdAt": now.isoformat().replace("+00:00", "Z"),
    "expiresAt": (now + timedelta(minutes=ttl)).isoformat().replace("+00:00", "Z"),
    "consumedAt": None,
}
path.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".recovery.", dir=path.parent, text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(request, handle, separators=(",", ":"))
    handle.write("\n")
os.chmod(temporary, 0o640)
os.chown(temporary, 0, runtime_gid)
os.replace(temporary, path)
PY

printf '%s\n' "Demande locale créée pour ${TTL_MINUTES} minutes."
printf '%s\n' "Jeton de récupération (affichage unique):"
printf '%s\n' "$token"
printf '%s\n' "Ouvrez ${ROOMFRAME_PUBLIC_URL}/ puis choisissez « Récupération locale »."
unset token token_hash
