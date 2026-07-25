#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
KEY_ID=""
PUBLIC_KEY=""
EXPECTED_SHA256=""
REPLACE=0

usage() {
  cat <<'USAGE'
Usage:
  sudo roomframe-trust-update-key \
    --key-id release-main \
    --public-key /chemin/release-main.pem \
    --sha256 EMPREINTE_SHA256 [--replace]

Installe une clé publique Ed25519 après vérification d'une empreinte reçue par
un canal indépendant. Aucune clé privée n'est acceptée.
USAGE
}

while (($#)); do
  case "$1" in
    --key-id)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --key-id" >&2; exit 2; }
      KEY_ID="$2"
      shift 2
      ;;
    --public-key)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --public-key" >&2; exit 2; }
      PUBLIC_KEY="$2"
      shift 2
      ;;
    --sha256)
      [[ $# -ge 2 ]] || { echo "Valeur manquante après --sha256" >&2; exit 2; }
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "Exécutez cette commande avec sudo/root." >&2
  exit 1
}
[[ "$KEY_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]] || {
  echo "--key-id est invalide." >&2
  exit 2
}
[[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "--sha256 doit être une empreinte hexadécimale de 64 caractères." >&2
  exit 2
}
[[ -f "$PUBLIC_KEY" && ! -L "$PUBLIC_KEY" ]] || {
  echo "La clé publique doit être un fichier régulier, pas un lien symbolique." >&2
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
  echo "ROOMFRAME_RUNTIME_GID est absent ou invalide." >&2
  exit 1
}
ACTUAL_SHA256="$(sha256sum "$PUBLIC_KEY" | awk '{print $1}')"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || {
  echo "Empreinte de clé publique invalide; installation refusée." >&2
  exit 1
}
KEY_DESCRIPTION="$(openssl pkey -pubin -in "$PUBLIC_KEY" -text -noout 2>/dev/null)" || {
  echo "La clé publique n'est pas lisible par OpenSSL." >&2
  exit 1
}
grep -qi 'ED25519' <<<"$KEY_DESCRIPTION" || {
  echo "Seules les clés publiques Ed25519 sont acceptées." >&2
  exit 1
}

TRUST_DIR="$DATA_DIR/pki/update-trust"
DESTINATION="$TRUST_DIR/${KEY_ID}.pem"
[[ ! -L "$TRUST_DIR" && ! -L "$DESTINATION" ]] || {
  echo "Un lien symbolique est interdit dans le magasin de confiance." >&2
  exit 1
}
mkdir -p "$TRUST_DIR"
chmod 0750 "$TRUST_DIR"
chown "root:${RUNTIME_GID}" "$TRUST_DIR"

if [[ -e "$DESTINATION" ]]; then
  EXISTING_SHA256="$(sha256sum "$DESTINATION" | awk '{print $1}')"
  if [[ "$EXISTING_SHA256" == "$EXPECTED_SHA256" ]]; then
    printf 'Clé déjà approuvée: %s (%s)\n' "$KEY_ID" "$EXPECTED_SHA256"
    exit 0
  fi
  [[ "$REPLACE" -eq 1 ]] || {
    echo "Une autre clé existe déjà; --replace est requis pour une rotation explicite." >&2
    exit 1
  }
fi

TEMPORARY="$(mktemp "$TRUST_DIR/.${KEY_ID}.XXXXXX")"
trap 'rm -f "$TEMPORARY"' EXIT
install -m 0640 -o root -g "$RUNTIME_GID" "$PUBLIC_KEY" "$TEMPORARY"
[[ "$(sha256sum "$TEMPORARY" | awk '{print $1}')" == "$EXPECTED_SHA256" ]] || {
  echo "La copie de la clé publique a échoué au contrôle." >&2
  exit 1
}
mv -f "$TEMPORARY" "$DESTINATION"
trap - EXIT
printf 'Clé publique approuvée: %s (%s)\n' "$KEY_ID" "$EXPECTED_SHA256"
