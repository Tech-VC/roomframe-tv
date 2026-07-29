#!/usr/bin/env bash
set -Eeuo pipefail

PUBLIC_KEY_DER=""
CA_CERTIFICATE=""
CA_PRIVATE_KEY=""
SCREEN_ID=""
SERIAL_HEX=""
OUTPUT_CERTIFICATE=""
VALIDITY_DAYS="${ROOMFRAME_TV_CERTIFICATE_VALIDITY_DAYS:-90}"

usage() {
  cat <<'USAGE'
Usage:
  issue-tv-certificate.sh \
    --public-key-der /chemin/public.der \
    --ca-certificate /chemin/ca.crt \
    --ca-private-key /chemin/ca.key \
    --screen-id UUID \
    --serial HEX \
    --output /chemin/client.crt

Émet un certificat client TLS à partir d'une clé publique SPKI DER. La clé
privée de la TV n'est jamais requise. La sortie standard contient, séparés par
des tabulations : empreinte SHA-256, numéro de série et date d'expiration.
USAGE
}

while (($#)); do
  case "$1" in
    --public-key-der) PUBLIC_KEY_DER="${2:-}"; shift 2 ;;
    --ca-certificate) CA_CERTIFICATE="${2:-}"; shift 2 ;;
    --ca-private-key) CA_PRIVATE_KEY="${2:-}"; shift 2 ;;
    --screen-id) SCREEN_ID="${2:-}"; shift 2 ;;
    --serial) SERIAL_HEX="${2:-}"; shift 2 ;;
    --output) OUTPUT_CERTIFICATE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$SCREEN_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || { echo "Identifiant TV invalide." >&2; exit 2; }
[[ "$SERIAL_HEX" =~ ^[A-F0-9]{2,40}$ ]] \
  || { echo "Numéro de série X.509 invalide." >&2; exit 2; }
[[ "$VALIDITY_DAYS" =~ ^[0-9]+$ ]] \
  && ((10#$VALIDITY_DAYS >= 30 && 10#$VALIDITY_DAYS <= 397)) \
  || { echo "Validité X.509 hors limites (30 à 397 jours)." >&2; exit 2; }

for input in "$PUBLIC_KEY_DER" "$CA_CERTIFICATE" "$CA_PRIVATE_KEY"; do
  [[ -f "$input" && -s "$input" && ! -L "$input" ]] \
    || { echo "Entrée PKI absente, vide ou non régulière: $input" >&2; exit 1; }
done
[[ -n "$OUTPUT_CERTIFICATE" && ! -e "$OUTPUT_CERTIFICATE" ]] \
  || { echo "La sortie doit être un nouveau fichier." >&2; exit 1; }
output_parent="$(dirname "$OUTPUT_CERTIFICATE")"
[[ -d "$output_parent" && ! -L "$output_parent" ]] \
  || { echo "Répertoire de sortie invalide." >&2; exit 1; }

temporary="$(mktemp -d "${TMPDIR:-/tmp}/roomframe-tv-certificate.XXXXXX")"
cleanup() {
  find "$temporary" -depth -mindepth 1 -delete 2>/dev/null || true
  rmdir "$temporary" 2>/dev/null || true
}
trap cleanup EXIT

public_pem="$temporary/public.pem"
extensions="$temporary/extensions.cnf"
certificate="$temporary/client.crt"

openssl pkey \
  -pubin \
  -inform DER \
  -in "$PUBLIC_KEY_DER" \
  -out "$public_pem" \
  >/dev/null

key_description="$(openssl pkey -pubin -in "$public_pem" -text -noout)"
grep -Eq 'Public-Key: \((2048|3072|4096) bit\)' <<<"$key_description" \
  || { echo "Seules les clés RSA de 2048 à 4096 bits sont acceptées." >&2; exit 1; }
grep -Eq 'Exponent: 65537 \(0x10001\)' <<<"$key_description" \
  || { echo "Exposant RSA non pris en charge." >&2; exit 1; }

printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=critical,clientAuth' \
  "subjectAltName=URI:urn:roomframe:tv:${SCREEN_ID}" \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' \
  >"$extensions"

openssl x509 \
  -new \
  -force_pubkey "$public_pem" \
  -CA "$CA_CERTIFICATE" \
  -CAkey "$CA_PRIVATE_KEY" \
  -set_serial "0x${SERIAL_HEX}" \
  -days "$VALIDITY_DAYS" \
  -sha256 \
  -subj "/CN=RoomFrame TV ${SCREEN_ID}" \
  -extfile "$extensions" \
  -out "$certificate"

openssl verify \
  -CAfile "$CA_CERTIFICATE" \
  -purpose sslclient \
  "$certificate" \
  >/dev/null

certificate_public_sha="$(
  openssl x509 -in "$certificate" -pubkey -noout \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r \
    | awk '{print $1}'
)"
source_public_sha="$(
  openssl pkey -pubin -in "$public_pem" -outform DER 2>/dev/null \
    | openssl dgst -sha256 -r \
    | awk '{print $1}'
)"
[[ "$certificate_public_sha" == "$source_public_sha" ]] \
  || { echo "La clé publique du certificat ne correspond pas à la demande." >&2; exit 1; }

fingerprint="$(
  openssl x509 -in "$certificate" -fingerprint -sha256 -noout \
    | sed 's/^[^=]*=//; s/://g' \
    | tr '[:upper:]' '[:lower:]'
)"
serial="$(
  openssl x509 -in "$certificate" -serial -noout \
    | sed 's/^[^=]*=//' \
    | tr '[:lower:]' '[:upper:]'
)"
expires_at="$(
  openssl x509 -in "$certificate" -enddate -noout -dateopt iso_8601 \
    | sed 's/^[^=]*=//'
)"
[[ "$fingerprint" =~ ^[a-f0-9]{64}$ && "$serial" == "$SERIAL_HEX" ]] \
  || { echo "Métadonnées X.509 générées invalides." >&2; exit 1; }

install -m 0644 "$certificate" "$OUTPUT_CERTIFICATE"
printf '%s\t%s\t%s\n' "$fingerprint" "$serial" "$expires_at"
