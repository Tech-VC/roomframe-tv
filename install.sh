#!/usr/bin/env bash
set -Eeuo pipefail

ROOMFRAME_VERSION="0.3.0"
DEFAULT_ARCHIVE_URL="__ROOMFRAME_ARCHIVE_URL__"
DEFAULT_ARCHIVE_SHA256="__ROOMFRAME_ARCHIVE_SHA256__"
DEFAULT_UPDATE_GITHUB_REPOSITORY="__ROOMFRAME_UPDATE_GITHUB_REPOSITORY__"

INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
HOST_OVERRIDE="${ROOMFRAME_HOST:-}"
UPDATE_REPOSITORY_OVERRIDE="${ROOMFRAME_UPDATE_GITHUB_REPOSITORY:-}"
UPDATE_REPOSITORY_EXPLICIT=0
[[ -z "${ROOMFRAME_UPDATE_GITHUB_REPOSITORY+x}" ]] || UPDATE_REPOSITORY_EXPLICIT=1
UPDATE_CHANNEL_OVERRIDE="${ROOMFRAME_UPDATE_GITHUB_CHANNEL:-}"
UPDATE_CHANNEL_EXPLICIT=0
[[ -z "${ROOMFRAME_UPDATE_GITHUB_CHANNEL+x}" ]] || UPDATE_CHANNEL_EXPLICIT=1
UPDATE_POLL_OVERRIDE="${ROOMFRAME_UPDATE_POLL_MINUTES:-}"
UPDATE_POLL_EXPLICIT=0
[[ -z "${ROOMFRAME_UPDATE_POLL_MINUTES+x}" ]] || UPDATE_POLL_EXPLICIT=1
SOURCE_DIR=""
NO_START=0

usage() {
  cat <<'USAGE'
Installation locale de RoomFrame TV

Usage:
  sudo ./install.sh [--host roomframe.exemple.local] [--source /chemin/du/depot]
                    [--updates-repository owner/repo] [--updates-channel stable|preview]
                    [--update-poll-minutes 360] [--disable-github-updates] [--no-start]

Le réseau du serveur Debian/CT doit déjà être configuré. RoomFrame détecte son
IPv4 et son suffixe DNS, mais ne modifie ni IP, ni masque, ni passerelle, ni DNS.
USAGE
}

while (($#)); do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --host" >&2; exit 2; }
      HOST_OVERRIDE="$2"
      shift 2
      ;;
    --source)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --source" >&2; exit 2; }
      SOURCE_DIR="$2"
      shift 2
      ;;
    --updates-repository)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --updates-repository" >&2; exit 2; }
      UPDATE_REPOSITORY_OVERRIDE="$2"
      UPDATE_REPOSITORY_EXPLICIT=1
      shift 2
      ;;
    --updates-channel)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --updates-channel" >&2; exit 2; }
      UPDATE_CHANNEL_OVERRIDE="$2"
      UPDATE_CHANNEL_EXPLICIT=1
      shift 2
      ;;
    --update-poll-minutes)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --update-poll-minutes" >&2; exit 2; }
      UPDATE_POLL_OVERRIDE="$2"
      UPDATE_POLL_EXPLICIT=1
      shift 2
      ;;
    --disable-github-updates)
      UPDATE_REPOSITORY_OVERRIDE=""
      UPDATE_REPOSITORY_EXPLICIT=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Option inconnue: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Erreur: lancez cette commande avec sudo/root." >&2
  exit 1
fi

log() { printf '\033[1;34m[RoomFrame]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[Attention]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[Erreur]\033[0m %s\n' "$*" >&2; exit 1; }

validate_managed_path() {
  local label="$1" value="$2" component current=""
  local -a components
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || fail "$label doit être un chemin absolu sans espace ni caractère de contrôle."
  [[ "$value" =~ ^/[^/]+/[^/]+ ]] \
    || fail "$label doit cibler un sous-répertoire dédié, pas un répertoire système large."
  [[
    "$value" != "/"
    && "$value" != *"/../"*
    && "$value" != */..
    && "$value" != *"/./"*
    && "$value" != */.
  ]] \
    || fail "$label est trop large ou contient '..'."
  IFS='/' read -r -a components <<<"$value"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || fail "$label traverse un lien symbolique: $current"
  done
}

validate_managed_path ROOMFRAME_INSTALL_DIR "$INSTALL_DIR"
validate_managed_path ROOMFRAME_CONFIG_DIR "$CONFIG_DIR"
validate_managed_path ROOMFRAME_DATA_DIR "$DATA_DIR"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMP_SOURCE=""
cleanup() {
  if [[ -n "$TEMP_SOURCE" && -d "$TEMP_SOURCE" ]]; then
    find "$TEMP_SOURCE" -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$TEMP_SOURCE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

is_ipv4() {
  local value="$1" octet
  local -a octets
  [[ "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS='.' read -r -a octets <<<"$value"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || return 1
  done
}

is_dns_name() {
  local value="$1"
  [[ ${#value} -le 253 ]] || return 1
  [[ "$value" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

normalize_host() {
  local value="${1%.}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$value" ]] || return 1
  [[ "$value" != *"://"* && "$value" != *"/"* && "$value" != *":"* ]] || return 1
  if [[ "$value" =~ ^[0-9.]+$ ]] && ! is_ipv4 "$value"; then
    return 1
  fi
  if is_ipv4 "$value" || is_dns_name "$value"; then
    printf '%s\n' "$value"
    return 0
  fi
  return 1
}

is_github_repository() {
  local value="$1"
  [[
    "$value" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$
    && "$value" != *".."*
    && "$value" != *.git
  ]]
}

runtime_value() {
  local file="$1" key="$2"
  awk -F= -v expected="$key" '
    $1 == expected {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file"
}

github_repository_from_git() {
  local source="$1" remote=""
  command -v git >/dev/null 2>&1 || return 1
  remote="$(git -C "$source" remote get-url origin 2>/dev/null || true)"
  case "$remote" in
    https://github.com/*)
      remote="${remote#https://github.com/}"
      ;;
    git@github.com:*)
      remote="${remote#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      remote="${remote#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
  remote="${remote%.git}"
  is_github_repository "$remote" || return 1
  printf '%s\n' "$remote"
}

if [[ -z "$SOURCE_DIR" && -f "$SCRIPT_DIR/compose.yaml" ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
fi

install_archive_dependencies() {
  local missing=0 command_name
  for command_name in ca-certificates curl python3 tar sha256sum; do
    if [[ "$command_name" == "ca-certificates" ]]; then
      [[ -r /etc/ssl/certs/ca-certificates.crt ]] || missing=1
    else
      command -v "$command_name" >/dev/null 2>&1 || missing=1
    fi
  done
  [[ "$missing" -eq 0 ]] && return
  command -v apt-get >/dev/null 2>&1 \
    || fail "Les outils d'extraction manquent et apt-get est indisponible."
  log "Installation des outils minimaux de téléchargement et d'extraction…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl python3 tar coreutils
}

# L'asset d'installation publié reçoit l'URL et le SHA-256 de l'archive par la CI.
if [[ -z "$SOURCE_DIR" ]]; then
  ARCHIVE_URL="${ROOMFRAME_ARCHIVE_URL:-$DEFAULT_ARCHIVE_URL}"
  ARCHIVE_SHA256="${ROOMFRAME_ARCHIVE_SHA256:-$DEFAULT_ARCHIVE_SHA256}"
  if [[ -z "$ARCHIVE_URL" || "$ARCHIVE_URL" == "__ROOMFRAME_ARCHIVE_URL__" ]]; then
    fail "Exécutez install.sh depuis le dépôt, utilisez --source, ou utilisez une release officielle."
  fi
  if [[ -z "$ARCHIVE_SHA256" || "$ARCHIVE_SHA256" == "__ROOMFRAME_ARCHIVE_SHA256__" ]]; then
    if [[ "${ROOMFRAME_ALLOW_UNVERIFIED_ARCHIVE:-0}" != "1" ]]; then
      fail "Le SHA-256 de l'archive est absent. Une archive non vérifiée est refusée."
    fi
    warn "Archive non vérifiée explicitement autorisée pour ce test."
  fi
  install_archive_dependencies
  command -v curl >/dev/null 2>&1 || fail "curl est requis."
  command -v tar >/dev/null 2>&1 || fail "tar est requis."
  TEMP_SOURCE="$(mktemp -d /tmp/roomframe-source.XXXXXX)"
  log "Téléchargement de RoomFrame…"
  curl --proto '=https' --tlsv1.2 -fsSL "$ARCHIVE_URL" -o "$TEMP_SOURCE/source.tar.gz"
  if [[ -n "$ARCHIVE_SHA256" && "$ARCHIVE_SHA256" != "__ROOMFRAME_ARCHIVE_SHA256__" ]]; then
    ACTUAL_SHA256="$(sha256sum "$TEMP_SOURCE/source.tar.gz" | awk '{print $1}')"
    [[ "$ACTUAL_SHA256" == "$ARCHIVE_SHA256" ]] || fail "SHA-256 de l'archive invalide."
  fi
  mkdir -p "$TEMP_SOURCE/unpacked"
  python3 - "$TEMP_SOURCE/source.tar.gz" "$TEMP_SOURCE/unpacked" <<'PY'
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
        original_name = member.name
        while original_name.startswith("./"):
            original_name = original_name[2:]
        if original_name in {"", "."} and member.isdir():
            continue
        path = pathlib.PurePosixPath(original_name)
        normalized = path.as_posix()
        if (
            path.is_absolute()
            or not path.parts
            or any(part in {"", ".", ".."} for part in path.parts)
            or normalized in seen
        ):
            raise SystemExit(f"Chemin d'archive non sûr: {member.name!r}")
        seen.add(normalized)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"Type d'archive interdit: {member.name!r}")
        total_size += member.size
        if total_size > 2 * 1024 * 1024 * 1024:
            raise SystemExit("Archive source décompressée trop volumineuse.")
        target = (destination / pathlib.Path(*path.parts)).resolve()
        if destination not in target.parents and target != destination:
            raise SystemExit(f"Sortie d'archive interdite: {member.name!r}")
        member.name = normalized
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        if member.isdir():
            member.mode = 0o755
        else:
            member.mode = 0o755 if member.mode & 0o111 else 0o644
        members.append(member)
    archive.extractall(destination, members=members)
PY
  SOURCE_DIR="$(
    find "$TEMP_SOURCE/unpacked" -maxdepth 3 -type f -name compose.yaml \
      -exec dirname {} \; | head -n 1
  )"
  [[ -n "$SOURCE_DIR" ]] || fail "L'archive ne contient pas compose.yaml."
fi

SOURCE_DIR="$(cd -- "$SOURCE_DIR" && pwd)"
[[ -f "$SOURCE_DIR/compose.yaml" ]] || fail "compose.yaml introuvable dans $SOURCE_DIR"
[[ -f "$SOURCE_DIR/infra/Caddyfile" ]] || fail "infra/Caddyfile introuvable dans $SOURCE_DIR"
[[ -f "$SOURCE_DIR/defaults/experience/manifest.json" ]] || fail "Expérience par défaut incomplète."
[[ -f "$SOURCE_DIR/scripts/source-excludes.txt" ]] \
  || fail "Liste d’exclusion des sources introuvable."

install_dependencies() {
  local need_apt=0 command_name
  for command_name in curl openssl python3 tar ip sha256sum flock; do
    command -v "$command_name" >/dev/null 2>&1 || need_apt=1
  done
  command -v docker >/dev/null 2>&1 || need_apt=1

  if [[ "$need_apt" -eq 1 ]]; then
    command -v apt-get >/dev/null 2>&1 || fail "Des dépendances manquent et apt-get est indisponible."
    log "Installation des dépendances système manquantes…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl openssl python3 tar iproute2 coreutils util-linux docker.io
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  if ! command -v getent >/dev/null 2>&1 || ! command -v useradd >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 \
      || fail "Les outils de création du compte système RoomFrame sont introuvables."
    apt-get install -y passwd
  fi

  if docker compose version >/dev/null 2>&1; then
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    return
  fi

  command -v apt-get >/dev/null 2>&1 || fail "Docker Compose est introuvable."
  log "Installation de Docker Compose…"
  apt-get install -y docker-compose-plugin 2>/dev/null \
    || apt-get install -y docker-compose-v2 2>/dev/null \
    || apt-get install -y docker-compose
  docker compose version >/dev/null 2>&1 \
    || command -v docker-compose >/dev/null 2>&1 \
    || fail "Docker Compose reste introuvable."
}

install_dependencies

INSTALL_LOCK_FILE="/run/lock/roomframe-install.lock"
mkdir -p "$(dirname "$INSTALL_LOCK_FILE")"
exec 9>"$INSTALL_LOCK_FILE"
flock -n 9 \
  || fail "Une installation ou mise à jour RoomFrame est déjà en cours."

RUNTIME_USER="roomframe"
if ! getent passwd "$RUNTIME_USER" >/dev/null 2>&1; then
  NOLOGIN_SHELL="$(command -v nologin 2>/dev/null || printf '%s' /usr/sbin/nologin)"
  useradd \
    --system \
    --user-group \
    --home-dir /nonexistent \
    --shell "$NOLOGIN_SHELL" \
    "$RUNTIME_USER"
fi
RUNTIME_UID="$(id -u "$RUNTIME_USER")"
RUNTIME_GID="$(id -g "$RUNTIME_USER")"
RUNTIME_SHELL="$(getent passwd "$RUNTIME_USER" | awk -F: '{print $7}')"
[[ "$RUNTIME_UID" =~ ^[0-9]+$ && "$RUNTIME_GID" =~ ^[0-9]+$ ]] \
  || fail "Le compte système $RUNTIME_USER est invalide."
((RUNTIME_UID > 0 && RUNTIME_GID > 0)) \
  || fail "Le compte système $RUNTIME_USER ne peut pas être root."
[[ "$RUNTIME_SHELL" == */nologin || "$RUNTIME_SHELL" == */false ]] \
  || fail "Le compte existant $RUNTIME_USER possède un shell interactif; installation refusée."

SERVER_IP="$(
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
)"
if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP="$(
    ip -o -4 addr show scope global 2>/dev/null \
      | awk '{sub(/\/.*/, "", $4); print $4; exit}'
  )"
fi
is_ipv4 "$SERVER_IP" || fail "Impossible de détecter une IPv4 principale valide."
[[ "$SERVER_IP" != 127.* && "$SERVER_IP" != 169.254.* ]] \
  || fail "L'IPv4 détectée ($SERVER_IP) n'est pas exploitable sur le LAN."

DOMAIN_SUFFIX="$(hostname -d 2>/dev/null || true)"
if [[ -z "$DOMAIN_SUFFIX" && -r /etc/resolv.conf ]]; then
  DOMAIN_SUFFIX="$(
    awk '/^(search|domain)[[:space:]]+/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true
  )"
fi
DOMAIN_SUFFIX="${DOMAIN_SUFFIX%.}"
DOMAIN_SUFFIX="$(printf '%s' "$DOMAIN_SUFFIX" | tr '[:upper:]' '[:lower:]')"
if [[ -n "$DOMAIN_SUFFIX" ]] && ! is_dns_name "$DOMAIN_SUFFIX"; then
  warn "Le suffixe DNS détecté est invalide; l'IPv4 sera utilisée par défaut."
  DOMAIN_SUFFIX=""
fi

if [[ -n "$HOST_OVERRIDE" ]]; then
  PRIMARY_HOST="$(normalize_host "$HOST_OVERRIDE")" \
    || fail "--host doit être un nom DNS valide ou l'IPv4 principale, sans schéma ni chemin."
elif [[ -n "$DOMAIN_SUFFIX" ]]; then
  PRIMARY_HOST="roomframe.${DOMAIN_SUFFIX}"
else
  PRIMARY_HOST="$SERVER_IP"
fi

if is_ipv4 "$PRIMARY_HOST" && [[ "$PRIMARY_HOST" != "$SERVER_IP" ]]; then
  fail "--host avec une IPv4 doit correspondre à l'IPv4 principale détectée ($SERVER_IP)."
fi

PREFERRED_URL="https://${PRIMARY_HOST}"
FALLBACK_URL="https://${SERVER_IP}"
API_URL="${PREFERRED_URL}/api"
DNS_WARNING=0

if is_ipv4 "$PRIMARY_HOST"; then
  SITE_ADDRESSES="$PREFERRED_URL"
else
  SITE_ADDRESSES="${PREFERRED_URL}, ${FALLBACK_URL}"
  RESOLVED_IPS="$(
    if command -v timeout >/dev/null 2>&1; then
      timeout 3 getent ahostsv4 "$PRIMARY_HOST" 2>/dev/null || true
    else
      getent ahostsv4 "$PRIMARY_HOST" 2>/dev/null || true
    fi | awk '{print $1}' | sort -u
  )"
  if ! grep -Fqx "$SERVER_IP" <<<"$RESOLVED_IPS"; then
    DNS_WARNING=1
    warn "$PRIMARY_HOST ne pointe pas encore vers $SERVER_IP; l'URL IP reste disponible."
  fi
fi

TIMEZONE="UTC"
if [[ -r /etc/timezone ]]; then
  TIMEZONE="$(tr -d '\r\n' </etc/timezone)"
elif command -v timedatectl >/dev/null 2>&1; then
  TIMEZONE="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
fi
[[ "$TIMEZONE" =~ ^[A-Za-z0-9_+/-]+$ ]] || TIMEZONE="UTC"

previous_runtime="$CONFIG_DIR/runtime.conf"
if [[ "$UPDATE_REPOSITORY_EXPLICIT" -eq 0 ]]; then
  if [[ -r "$previous_runtime" ]] \
    && grep -q '^ROOMFRAME_UPDATE_GITHUB_REPOSITORY=' "$previous_runtime"; then
    UPDATE_REPOSITORY_OVERRIDE="$(
      runtime_value "$previous_runtime" ROOMFRAME_UPDATE_GITHUB_REPOSITORY
    )"
  elif [[
    "$DEFAULT_UPDATE_GITHUB_REPOSITORY" != "__ROOMFRAME_UPDATE_GITHUB_REPOSITORY__"
  ]]; then
    UPDATE_REPOSITORY_OVERRIDE="$DEFAULT_UPDATE_GITHUB_REPOSITORY"
  else
    UPDATE_REPOSITORY_OVERRIDE="$(github_repository_from_git "$SOURCE_DIR" || true)"
  fi
fi
if [[ -n "$UPDATE_REPOSITORY_OVERRIDE" ]]; then
  is_github_repository "$UPDATE_REPOSITORY_OVERRIDE" \
    || fail "Le dépôt d'updates GitHub doit respecter owner/repo."
fi

if [[ "$UPDATE_CHANNEL_EXPLICIT" -eq 0 && -r "$previous_runtime" ]] \
  && grep -q '^ROOMFRAME_UPDATE_GITHUB_CHANNEL=' "$previous_runtime"; then
  UPDATE_CHANNEL_OVERRIDE="$(
    runtime_value "$previous_runtime" ROOMFRAME_UPDATE_GITHUB_CHANNEL
  )"
fi
UPDATE_CHANNEL_OVERRIDE="${UPDATE_CHANNEL_OVERRIDE:-stable}"
[[ "$UPDATE_CHANNEL_OVERRIDE" == "stable" || "$UPDATE_CHANNEL_OVERRIDE" == "preview" ]] \
  || fail "Le canal d'updates doit être stable ou preview."

if [[ "$UPDATE_POLL_EXPLICIT" -eq 0 && -r "$previous_runtime" ]] \
  && grep -q '^ROOMFRAME_UPDATE_POLL_MINUTES=' "$previous_runtime"; then
  UPDATE_POLL_OVERRIDE="$(
    runtime_value "$previous_runtime" ROOMFRAME_UPDATE_POLL_MINUTES
  )"
fi
UPDATE_POLL_OVERRIDE="${UPDATE_POLL_OVERRIDE:-360}"
[[ "$UPDATE_POLL_OVERRIDE" =~ ^[0-9]+$ ]] \
  && ((10#$UPDATE_POLL_OVERRIDE >= 15 && 10#$UPDATE_POLL_OVERRIDE <= 10080)) \
  || fail "La fréquence d'updates doit être comprise entre 15 et 10080 minutes."

if [[ -d "$DATA_DIR/postgres" ]] \
  && find "$DATA_DIR/postgres" -mindepth 1 -print -quit | grep -q .; then
  previous_backup="$INSTALL_DIR/scripts/roomframe-backup.sh"
  if [[ ! -r "$previous_runtime" || ! -x "$previous_backup" ]]; then
    fail "Des données PostgreSQL existent mais l'outil de sauvegarde RoomFrame est absent; mise à jour refusée."
  fi
  log "Sauvegarde pré-migration de l'instance existante…"
  ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
  ROOMFRAME_RUNTIME_CONFIG="$previous_runtime" \
    "$previous_backup"
fi

log "Copie non destructive du code…"
mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd -- "$INSTALL_DIR" && pwd)"
if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
  tar \
    --exclude-from="$SOURCE_DIR/scripts/source-excludes.txt" \
    -C "$SOURCE_DIR" -cf - . \
    | tar --no-same-owner --no-same-permissions -C "$INSTALL_DIR" -xf -
else
  log "Le dépôt est déjà installé dans $INSTALL_DIR; aucune recopie nécessaire."
fi

# Les commandes installées seront ensuite invoquées avec sudo. Le code ne doit
# donc jamais rester modifiable par le propriétaire de la copie source.
chown -R root:root "$INSTALL_DIR"
find "$INSTALL_DIR" -xdev -type d -exec chmod go-w {} +
find "$INSTALL_DIR" -xdev -type f -exec chmod go-w {} +

log "Préparation des données persistantes et des secrets…"
ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$INSTALL_DIR/defaults/experience" \
ROOMFRAME_RUNTIME_UID="$RUNTIME_UID" \
ROOMFRAME_RUNTIME_GID="$RUNTIME_GID" \
  "$INSTALL_DIR/scripts/bootstrap.sh"

mkdir -p "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"

RUNTIME_TMP="$(mktemp "$CONFIG_DIR/.runtime-conf.XXXXXX")"
cat >"$RUNTIME_TMP" <<RUNTIME
ROOMFRAME_VERSION=${ROOMFRAME_VERSION}
ROOMFRAME_INSTALL_DIR=${INSTALL_DIR}
ROOMFRAME_CONFIG_DIR=${CONFIG_DIR}
ROOMFRAME_DATA_DIR=${DATA_DIR}
ROOMFRAME_SERVER_IP=${SERVER_IP}
ROOMFRAME_PRIMARY_HOST=${PRIMARY_HOST}
ROOMFRAME_PUBLIC_URL=${PREFERRED_URL}
ROOMFRAME_PREFERRED_URL=${PREFERRED_URL}
ROOMFRAME_FALLBACK_URL=${FALLBACK_URL}
ROOMFRAME_API_URL=${API_URL}
ROOMFRAME_TIMEZONE=${TIMEZONE}
ROOMFRAME_RUNTIME_UID=${RUNTIME_UID}
ROOMFRAME_RUNTIME_GID=${RUNTIME_GID}
ROOMFRAME_UPDATE_GITHUB_REPOSITORY=${UPDATE_REPOSITORY_OVERRIDE}
ROOMFRAME_UPDATE_GITHUB_CHANNEL=${UPDATE_CHANNEL_OVERRIDE}
ROOMFRAME_UPDATE_POLL_MINUTES=${UPDATE_POLL_OVERRIDE}
RUNTIME
chmod 0640 "$RUNTIME_TMP"
chown root:root "$RUNTIME_TMP"
mv -f "$RUNTIME_TMP" "$CONFIG_DIR/runtime.conf"

python3 - "$INSTALL_DIR/infra/Caddyfile" "$CONFIG_DIR/Caddyfile" \
  "$SITE_ADDRESSES" "$SERVER_IP" <<'PY'
import os
import pathlib
import sys
import tempfile

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
addresses, default_sni = sys.argv[3:]
template = source.read_text(encoding="utf-8")
markers = {
    "__ROOMFRAME_SITE_ADDRESSES__": addresses,
    "__ROOMFRAME_DEFAULT_SNI__": default_sni,
}
for marker in markers:
    if template.count(marker) != 1:
        raise SystemExit(f"Le modèle Caddy doit contenir exactement un marqueur {marker}.")
rendered = template
for marker, value in markers.items():
    rendered = rendered.replace(marker, value)
destination.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".Caddyfile.", dir=destination.parent, text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    handle.write(rendered)
os.chmod(temporary, 0o640)
os.replace(temporary, destination)
PY

python3 - "$CONFIG_DIR/server-state.json" "$SERVER_IP" "$PRIMARY_HOST" \
  "$PREFERRED_URL" "$FALLBACK_URL" "$API_URL" "$ROOMFRAME_VERSION" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
ip, host, preferred, fallback, api, version = sys.argv[2:]
previous = {}
try:
    previous = json.loads(path.read_text(encoding="utf-8"))
except FileNotFoundError:
    pass

state = {
    "schemaVersion": 2,
    "serverReady": True,
    "networkManagedExternally": True,
    "serverIp": ip,
    "primaryHost": host,
    "adminUrl": preferred,
    "preferredAdminUrl": preferred,
    "fallbackAdminUrl": fallback,
    "apiUrl": api,
    "softwareVersion": version,
    "configured": bool(previous.get("configured", False)),
}
path.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".server-state.", dir=path.parent, text=True)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(state, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(temporary, 0o640)
os.replace(temporary, path)
PY
chown "root:${RUNTIME_GID}" "$CONFIG_DIR/server-state.json"
chmod 0640 "$CONFIG_DIR/server-state.json"

if [[ "${ROOMFRAME_SKIP_COMMAND_LINKS:-0}" != "1" ]]; then
  for command_name in roomframe-compose roomframe-diagnose roomframe-backup \
    roomframe-verify-backup roomframe-bootstrap-token roomframe-recover-admin \
    roomframe-trust-update-key; do
    source_name="$INSTALL_DIR/scripts/${command_name}.sh"
    target_name="/usr/local/sbin/$command_name"
    [[ -x "$source_name" ]] || fail "Commande d'exploitation manquante: $source_name"
    if [[ -e "$target_name" && ! -L "$target_name" ]]; then
      fail "Commande existante non gérée refusée: $target_name"
    fi
    ln -sfn "$source_name" "$target_name"
  done
fi

if [[ "$NO_START" -eq 0 ]]; then
  log "Démarrage des services…"
  # Recreate the containers even when the image tag is unchanged: Compose
  # otherwise keeps stale bind-mounted secret metadata after a permission or
  # ownership hardening performed by bootstrap.sh.
  "$INSTALL_DIR/scripts/roomframe-compose.sh" up -d --build --force-recreate --remove-orphans

  log "Vérification de l'interface HTTPS…"
  healthy=0
  for _ in $(seq 1 90); do
    if curl -kfsS --connect-timeout 2 \
      --resolve "${PRIMARY_HOST}:443:127.0.0.1" \
      "${PREFERRED_URL}/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  [[ "$healthy" -eq 1 ]] \
    || fail "Les services ont démarré mais /health ne répond pas. Exécutez: sudo roomframe-diagnose"

  for background_service in worker update-poller; do
    background_id="$(
      "$INSTALL_DIR/scripts/roomframe-compose.sh" ps -q "$background_service" 2>/dev/null || true
    )"
    [[ -n "$background_id" ]] \
      || fail "Le conteneur $background_service n'a pas été créé."
    background_healthy=0
    for _ in $(seq 1 60); do
      background_status="$(
        docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "$background_id" 2>/dev/null || true
      )"
      if [[ "$background_status" == "healthy" ]]; then
        background_healthy=1
        break
      fi
      [[ "$background_status" != "unhealthy" && "$background_status" != "exited" ]] \
        || break
      sleep 1
    done
    [[ "$background_healthy" -eq 1 ]] \
      || fail "Le service $background_service n'est pas sain (${background_status:-état inconnu}). Exécutez: sudo roomframe-compose logs $background_service"
  done
fi

CA_PATH="$DATA_DIR/caddy/caddy/pki/authorities/local/root.crt"
if [[ "$NO_START" -eq 0 ]]; then
  printf '\n\033[1;32mTout est prêt.\033[0m\n'
else
  printf '\n\033[1;33mPréparation terminée (--no-start); services non démarrés.\033[0m\n'
fi
printf 'Interface d’administration : %s\n' "$PREFERRED_URL"
printf 'API locale TV             : %s\n' "$API_URL"
printf 'URL de secours par IP     : %s\n' "$FALLBACK_URL"
printf 'Simulateur TV             : %s/simulator/\n' "$PREFERRED_URL"
printf 'Autorité HTTPS locale     : %s\n' "$CA_PATH"
printf 'Diagnostic                : sudo roomframe-diagnose\n'
printf 'Sauvegarde                 : sudo roomframe-backup\n'
if [[ -n "$UPDATE_REPOSITORY_OVERRIDE" ]]; then
  printf 'Updates GitHub signées     : %s · canal %s · toutes les %s min\n' \
    "$UPDATE_REPOSITORY_OVERRIDE" "$UPDATE_CHANNEL_OVERRIDE" "$UPDATE_POLL_OVERRIDE"
else
  printf 'Updates GitHub signées     : désactivées (import .rfupdate disponible)\n'
fi
printf 'Vérifier une sauvegarde    : sudo roomframe-verify-backup --latest\n'
printf 'Jeton initial              : sudo roomframe-bootstrap-token --show\n'
if [[ "$DNS_WARNING" -eq 1 ]]; then
  printf '\nDNS à créer dans la zone interne : %s  A  %s\n' "$PRIMARY_HOST" "$SERVER_IP"
fi
