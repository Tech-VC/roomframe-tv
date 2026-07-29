#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
RUNTIME_CONFIG="${ROOMFRAME_RUNTIME_CONFIG:-$CONFIG_DIR/runtime.conf}"
STAGING=""
AVAHI_TEMPORARY=""

usage() {
  cat <<'USAGE'
Usage: sudo roomframe-refresh-discovery

Régénère le manifeste public de découverte locale, le signe avec l'identité
ECDSA P-256 root-only de l'instance et actualise l'annonce Avahi lorsqu'elle
est activée. Cette commande ne modifie aucune adresse, route ou configuration
DNS du serveur.
USAGE
}

fail() {
  printf 'Actualisation de la découverte refusée: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$AVAHI_TEMPORARY" ]]; then
    rm -f "$AVAHI_TEMPORARY"
  fi
  if [[ -n "$STAGING" && -d "$STAGING" && ! -L "$STAGING" ]]; then
    find "$STAGING" -xdev -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$STAGING" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}
[[ $# -eq 0 ]] || { usage >&2; exit 2; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "exécution root requise"
[[ -r "$RUNTIME_CONFIG" ]] \
  || fail "configuration runtime introuvable: $RUNTIME_CONFIG"

set -a
# shellcheck source=/dev/null
source "$RUNTIME_CONFIG"
set +a

DATA_DIR="${ROOMFRAME_DATA_DIR:-/var/lib/roomframe}"
CONFIG_DIR="${ROOMFRAME_CONFIG_DIR:-/etc/roomframe}"
INSTALL_DIR="${ROOMFRAME_INSTALL_DIR:-/opt/roomframe}"
SERVER_STATE="${ROOMFRAME_SERVER_STATE_FILE:-$CONFIG_DIR/server-state.json}"
PRIVATE_KEY="${ROOMFRAME_DISCOVERY_SIGNING_KEY_FILE:-$CONFIG_DIR/secrets/discovery_signing_key}"
DISCOVERY_DIR="${ROOMFRAME_DISCOVERY_DIR:-$DATA_DIR/pki/discovery}"
SERVER_CA="${ROOMFRAME_SERVER_CA_FILE:-$DATA_DIR/pki/server-ca/ca.crt}"
AVAHI_ENABLED="${ROOMFRAME_DISCOVERY_AVAHI_ENABLED:-0}"
AVAHI_SERVICE_DIR="${ROOMFRAME_AVAHI_SERVICE_DIR:-/etc/avahi/services}"
AVAHI_TARGET="$AVAHI_SERVICE_DIR/roomframe.service"
AVAHI_TEMPLATE="$INSTALL_DIR/infra/avahi/roomframe.service"
VERIFY_COMMAND="${ROOMFRAME_VERIFY_DISCOVERY_COMMAND:-$INSTALL_DIR/scripts/verify-discovery-manifest.py}"

[[ "$AVAHI_ENABLED" == "0" || "$AVAHI_ENABLED" == "1" ]] \
  || fail "ROOMFRAME_DISCOVERY_AVAHI_ENABLED doit valoir 0 ou 1"
for command_name in openssl python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "commande requise absente: $command_name"
done
[[ -f "$SERVER_STATE" && -s "$SERVER_STATE" && ! -L "$SERVER_STATE" ]] \
  || fail "état serveur absent ou invalide"
[[ -f "$SERVER_CA" && -s "$SERVER_CA" && ! -L "$SERVER_CA" ]] \
  || fail "CA HTTPS publique absente ou invalide"
[[ -f "$PRIVATE_KEY" && -s "$PRIVATE_KEY" && ! -L "$PRIVATE_KEY" ]] \
  || fail "identité de découverte absente ou invalide"
[[ -x "$VERIFY_COMMAND" ]] \
  || fail "vérificateur de découverte absent: $VERIFY_COMMAND"
[[ "$(stat -c '%a:%u:%g' "$PRIVATE_KEY")" == "400:0:0" ]] \
  || fail "l'identité de découverte doit appartenir à root:root en mode 0400"
openssl pkey -in "$PRIVATE_KEY" -check -noout >/dev/null 2>&1 \
  || fail "identité de découverte illisible"
grep -Fq 'ASN1 OID: prime256v1' < <(
  openssl pkey -in "$PRIVATE_KEY" -pubout -text_pub -noout 2>/dev/null
) \
  || fail "l'identité de découverte doit utiliser ECDSA P-256"

[[ ! -e "$DISCOVERY_DIR" || ( -d "$DISCOVERY_DIR" && ! -L "$DISCOVERY_DIR" ) ]] \
  || fail "répertoire public de découverte invalide"
mkdir -p "$DISCOVERY_DIR"
chown root:root "$DISCOVERY_DIR"
chmod 0755 "$DISCOVERY_DIR"
STAGING="$(mktemp -d "$DISCOVERY_DIR/.refresh.XXXXXX")"
chmod 0700 "$STAGING"

openssl pkey -in "$PRIVATE_KEY" -pubout -out "$STAGING/public.pem" >/dev/null 2>&1
openssl pkey -in "$PRIVATE_KEY" -pubout -outform DER \
  >"$STAGING/public.der" 2>/dev/null
key_fingerprint="$(
  sha256sum "$STAGING/public.der" | awk '{print $1}'
)"
[[ "$key_fingerprint" =~ ^[0-9a-f]{64}$ ]] \
  || fail "empreinte de clé de découverte invalide"

openssl x509 -in "$SERVER_CA" -outform DER \
  >"$STAGING/server-ca.der" 2>/dev/null
ca_fingerprint="$(
  sha256sum "$STAGING/server-ca.der" | awk '{print $1}'
)"
[[ "$ca_fingerprint" =~ ^[0-9a-f]{64}$ ]] \
  || fail "empreinte de CA HTTPS invalide"

python3 - \
  "$SERVER_STATE" \
  "$STAGING/public.der" \
  "$key_fingerprint" \
  "$ca_fingerprint" \
  "$STAGING/payload.json" \
  "$STAGING/canonical.bin" <<'PY'
import base64
import datetime
import ipaddress
import json
import pathlib
import re
import sys
import urllib.parse

state_path, public_path, key_sha, ca_sha, payload_path, canonical_path = sys.argv[1:]
state = json.loads(pathlib.Path(state_path).read_text(encoding="utf-8"))
required_state = {
    "serverIp",
    "primaryHost",
    "preferredAdminUrl",
    "fallbackAdminUrl",
}
if not required_state.issubset(state):
    raise SystemExit("état serveur incomplet pour la découverte")
ipv4 = str(ipaddress.IPv4Address(state["serverIp"]))
host = str(state["primaryHost"]).lower()
if not re.fullmatch(
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
    host,
) and host != ipv4:
    raise SystemExit("hôte de découverte invalide")

def origin(value, expected_host):
    parsed = urllib.parse.urlsplit(str(value))
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_host
        or parsed.port not in {None, 443}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("origine HTTPS de découverte invalide")
    return f"https://{parsed.hostname}"

public_der = pathlib.Path(public_path).read_bytes()
payload = {
    "formatVersion": 1,
    "serviceType": "_roomframe._tcp",
    "path": "/api/v1/discovery",
    "origin": origin(state["preferredAdminUrl"], host),
    "fallbackOrigin": origin(state["fallbackAdminUrl"], ipv4),
    "host": host,
    "ipv4": ipv4,
    "port": 443,
    "serverCaFingerprintSha256": ca_sha,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
    "signing": {
        "algorithm": "ECDSA-P256-SHA256",
        "publicKeySpki": base64.urlsafe_b64encode(public_der).decode().rstrip("="),
        "publicKeyFingerprintSha256": key_sha,
    },
}
canonical = json.dumps(
    payload,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
).encode()
pathlib.Path(payload_path).write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
pathlib.Path(canonical_path).write_bytes(canonical)
PY

openssl dgst -sha256 \
  -sign "$PRIVATE_KEY" \
  -out "$STAGING/signature.bin" \
  "$STAGING/canonical.bin"
openssl dgst -sha256 \
  -verify "$STAGING/public.pem" \
  -signature "$STAGING/signature.bin" \
  "$STAGING/canonical.bin" >/dev/null \
  || fail "auto-vérification de la signature de découverte impossible"

python3 - \
  "$STAGING/payload.json" \
  "$STAGING/signature.bin" \
  "$STAGING/manifest.json" <<'PY'
import base64
import json
import pathlib
import sys

payload_path, signature_path, manifest_path = sys.argv[1:]
payload = json.loads(pathlib.Path(payload_path).read_text(encoding="utf-8"))
payload["signing"]["signature"] = base64.urlsafe_b64encode(
    pathlib.Path(signature_path).read_bytes()
).decode().rstrip("=")
pathlib.Path(manifest_path).write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

server_ip="$(
  python3 - "$SERVER_STATE" <<'PY'
import json
import pathlib
import sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(state["serverIp"])
PY
)"
primary_host="$(
  python3 - "$SERVER_STATE" <<'PY'
import json
import pathlib
import sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(state["primaryHost"])
PY
)"
"$VERIFY_COMMAND" \
  "$STAGING/manifest.json" \
  --expected-ip "$server_ip" \
  --expected-host "$primary_host" \
  --expected-ca-sha256 "$ca_fingerprint" >/dev/null

chmod 0644 "$STAGING/public.pem" "$STAGING/manifest.json"
chown root:root "$STAGING/public.pem" "$STAGING/manifest.json"
mv -f "$STAGING/public.pem" "$DISCOVERY_DIR/public.pem"
mv -f "$STAGING/manifest.json" "$DISCOVERY_DIR/manifest.json"
chmod 0644 "$DISCOVERY_DIR/public.pem" "$DISCOVERY_DIR/manifest.json"
chown root:root "$DISCOVERY_DIR/public.pem" "$DISCOVERY_DIR/manifest.json"

if [[ "$AVAHI_ENABLED" == "1" ]]; then
  [[ -f "$AVAHI_TEMPLATE" && ! -L "$AVAHI_TEMPLATE" ]] \
    || fail "modèle Avahi RoomFrame absent"
  [[ -d "$AVAHI_SERVICE_DIR" && ! -L "$AVAHI_SERVICE_DIR" ]] \
    || fail "répertoire de services Avahi absent ou invalide"
  AVAHI_TEMPORARY="$(mktemp "$AVAHI_SERVICE_DIR/.roomframe.XXXXXX")"
  python3 - "$AVAHI_TEMPLATE" "$AVAHI_TEMPORARY" "$key_fingerprint" <<'PY'
import pathlib
import sys

source, destination, fingerprint = sys.argv[1:]
template = pathlib.Path(source).read_text(encoding="utf-8")
marker = "__ROOMFRAME_DISCOVERY_KEY_SHA256__"
if template.count(marker) != 1:
    raise SystemExit("marqueur Avahi invalide")
pathlib.Path(destination).write_text(
    template.replace(marker, fingerprint),
    encoding="utf-8",
)
PY
  chmod 0644 "$AVAHI_TEMPORARY"
  chown root:root "$AVAHI_TEMPORARY"
  [[ ! -L "$AVAHI_TARGET" ]] \
    || fail "le service Avahi RoomFrame ne peut pas être un lien symbolique"
  mv -f "$AVAHI_TEMPORARY" "$AVAHI_TARGET"
  AVAHI_TEMPORARY=""
  if [[ "${ROOMFRAME_SKIP_AVAHI_RELOAD:-0}" != "1" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && [[ -d /run/systemd/system ]]; then
    if ! systemctl enable --now avahi-daemon >/dev/null \
      || ! systemctl reload-or-restart avahi-daemon; then
      printf '%s\n' \
        "Attention: le manifeste signé est prêt, mais Avahi n'a pas pu être activé; utilisez le DNS ou l'IP de secours." \
        >&2
    fi
  fi
elif [[ -e "$AVAHI_TARGET" ]]; then
  [[ -f "$AVAHI_TARGET" && ! -L "$AVAHI_TARGET" ]] \
    || fail "le service Avahi RoomFrame existant n'est pas un fichier régulier"
  rm -f "$AVAHI_TARGET"
  if [[ "${ROOMFRAME_SKIP_AVAHI_RELOAD:-0}" != "1" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active avahi-daemon >/dev/null 2>&1; then
    systemctl reload avahi-daemon
  fi
fi

find "$STAGING" -xdev -depth -mindepth 1 -delete
rmdir "$STAGING"
STAGING=""
trap - EXIT
printf 'Découverte locale signée actualisée: %s\n' "$key_fingerprint"
