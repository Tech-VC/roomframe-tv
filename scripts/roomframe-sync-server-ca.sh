#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"

usage() {
  cat <<'USAGE'
Usage: sudo roomframe-sync-server-ca

Copie uniquement le certificat public de la CA HTTPS interne de Caddy vers le
répertoire public monté en lecture seule dans l'API, puis régénère le manifeste
de découverte signé. Aucune clé privée Caddy n'est copiée ni rendue accessible
aux conteneurs applicatifs.
USAGE
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}
[[ $# -eq 0 ]] || { usage >&2; exit 2; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécution root requise." >&2
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
SOURCE_CERTIFICATE="${ROOMFRAME_CADDY_CA_FILE:-$DATA_DIR/caddy/caddy/pki/authorities/local/root.crt}"
PUBLIC_DIRECTORY="$DATA_DIR/pki/server-ca"
PUBLIC_CERTIFICATE="$PUBLIC_DIRECTORY/ca.crt"

[[ -f "$SOURCE_CERTIFICATE" && -s "$SOURCE_CERTIFICATE" && ! -L "$SOURCE_CERTIFICATE" ]] || {
  echo "CA HTTPS Caddy absente ou invalide: $SOURCE_CERTIFICATE" >&2
  exit 1
}
[[ ! -e "$PUBLIC_DIRECTORY" || ( -d "$PUBLIC_DIRECTORY" && ! -L "$PUBLIC_DIRECTORY" ) ]] || {
  echo "Répertoire public de CA serveur invalide: $PUBLIC_DIRECTORY" >&2
  exit 1
}

mkdir -p "$PUBLIC_DIRECTORY"
chown root:root "$PUBLIC_DIRECTORY"
chmod 0755 "$PUBLIC_DIRECTORY"

temporary="$(mktemp "$PUBLIC_DIRECTORY/.ca.XXXXXX")"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT
install -m 0644 -o root -g root "$SOURCE_CERTIFICATE" "$temporary"

openssl x509 -in "$temporary" -noout -checkend 0 >/dev/null \
  || { echo "La CA HTTPS Caddy est expirée ou illisible." >&2; exit 1; }
grep -Fq 'CA:TRUE' < <(
  openssl x509 -in "$temporary" -noout -text
) \
  || { echo "Le certificat HTTPS Caddy n'est pas une CA." >&2; exit 1; }
openssl verify -check_ss_sig -CAfile "$temporary" "$temporary" >/dev/null \
  || { echo "La CA HTTPS Caddy n'est pas auto-signée correctement." >&2; exit 1; }

if [[ -f "$PUBLIC_CERTIFICATE" && ! -L "$PUBLIC_CERTIFICATE" ]] \
  && cmp -s "$temporary" "$PUBLIC_CERTIFICATE"; then
  rm -f "$temporary"
else
  [[ ! -L "$PUBLIC_CERTIFICATE" ]] || {
    echo "Le certificat public cible ne doit pas être un lien symbolique." >&2
    exit 1
  }
  mv -f "$temporary" "$PUBLIC_CERTIFICATE"
fi
chmod 0644 "$PUBLIC_CERTIFICATE"
chown root:root "$PUBLIC_CERTIFICATE"

fingerprint="$(
  openssl x509 -in "$PUBLIC_CERTIFICATE" -fingerprint -sha256 -noout \
    | sed 's/^[^=]*=//; s/://g' \
    | tr '[:upper:]' '[:lower:]'
)"
[[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Empreinte de CA HTTPS invalide." >&2
  exit 1
}
printf 'CA HTTPS publique synchronisée: %s\n' "$fingerprint"

INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
REFRESH_DISCOVERY="${ROOMFRAME_REFRESH_DISCOVERY_COMMAND:-$INSTALL_DIR/scripts/roomframe-refresh-discovery.sh}"
[[ -x "$REFRESH_DISCOVERY" ]] || {
  echo "Commande d'actualisation de la découverte absente: $REFRESH_DISCOVERY" >&2
  exit 1
}
ROOMFRAME_RUNTIME_CONFIG="$RUNTIME_CONFIG" \
  "$REFRESH_DISCOVERY"
