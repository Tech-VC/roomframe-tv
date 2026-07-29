#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  printf '%s\n' "Ce test de découverte doit être lancé sous root." >&2
  exit 1
}
for command_name in age-keygen openssl python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Dépendance de découverte absente: %s\n' "$command_name" >&2
    exit 1
  }
done

TEST_ROOT="$(mktemp -d /tmp/roomframe-discovery-test.XXXXXX)"
cleanup() {
  if [[ -d "$TEST_ROOT" ]]; then
    find "$TEST_ROOT" -xdev -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$TEST_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

CONFIG_DIR="$TEST_ROOT/config"
DATA_DIR="$TEST_ROOT/data"
AVAHI_DIR="$TEST_ROOT/avahi"
mkdir -p "$AVAHI_DIR"

ROOMFRAME_CONFIG_DIR="$CONFIG_DIR" \
ROOMFRAME_DATA_DIR="$DATA_DIR" \
ROOMFRAME_DEFAULTS_DIR="$ROOT/defaults/experience" \
ROOMFRAME_RUNTIME_UID=65534 \
ROOMFRAME_RUNTIME_GID=65534 \
  "$ROOT/scripts/bootstrap.sh" >/dev/null

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -sha256 \
  -days 30 \
  -subj "/CN=RoomFrame Discovery Test CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$TEST_ROOT/ca.key" \
  -out "$DATA_DIR/pki/server-ca/ca.crt" >/dev/null 2>&1
chmod 0644 "$DATA_DIR/pki/server-ca/ca.crt"
chown root:root "$DATA_DIR/pki/server-ca/ca.crt"

python3 - "$CONFIG_DIR/server-state.json" <<'PY'
import json
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "schemaVersion": 2,
            "serverReady": True,
            "networkManagedExternally": True,
            "serverIp": "192.0.2.24",
            "primaryHost": "roomframe.example.local",
            "adminUrl": "https://roomframe.example.local",
            "preferredAdminUrl": "https://roomframe.example.local",
            "fallbackAdminUrl": "https://192.0.2.24",
            "apiUrl": "https://roomframe.example.local/api",
            "softwareVersion": "test",
            "configured": False,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
chmod 0640 "$CONFIG_DIR/server-state.json"
chown root:root "$CONFIG_DIR/server-state.json"

cat >"$CONFIG_DIR/runtime.conf" <<RUNTIME
ROOMFRAME_VERSION=test
ROOMFRAME_INSTALL_DIR=$ROOT
ROOMFRAME_CONFIG_DIR=$CONFIG_DIR
ROOMFRAME_DATA_DIR=$DATA_DIR
ROOMFRAME_SERVER_IP=192.0.2.24
ROOMFRAME_PRIMARY_HOST=roomframe.example.local
ROOMFRAME_PUBLIC_URL=https://roomframe.example.local
ROOMFRAME_PREFERRED_URL=https://roomframe.example.local
ROOMFRAME_FALLBACK_URL=https://192.0.2.24
ROOMFRAME_API_URL=https://roomframe.example.local/api
ROOMFRAME_RUNTIME_UID=65534
ROOMFRAME_RUNTIME_GID=65534
ROOMFRAME_DISCOVERY_AVAHI_ENABLED=1
RUNTIME
chmod 0640 "$CONFIG_DIR/runtime.conf"
chown root:root "$CONFIG_DIR/runtime.conf"

identity="$CONFIG_DIR/secrets/discovery_signing_key"
identity_hash_before="$(sha256sum "$identity" | awk '{print $1}')"
ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
ROOMFRAME_AVAHI_SERVICE_DIR="$AVAHI_DIR" \
ROOMFRAME_SKIP_AVAHI_RELOAD=1 \
  "$ROOT/scripts/roomframe-refresh-discovery.sh" >/dev/null
manifest="$DATA_DIR/pki/discovery/manifest.json"
[[ -f "$manifest" && ! -L "$manifest" ]] || {
  printf '%s\n' "Manifeste de découverte absent." >&2
  exit 1
}
ca_sha="$(
  openssl x509 -in "$DATA_DIR/pki/server-ca/ca.crt" -outform DER \
    | sha256sum | awk '{print $1}'
)"
"$ROOT/scripts/verify-discovery-manifest.py" \
  "$manifest" \
  --expected-ip 192.0.2.24 \
  --expected-host roomframe.example.local \
  --expected-ca-sha256 "$ca_sha" >/dev/null

key_sha="$(
  python3 - "$manifest" <<'PY'
import json
import pathlib
import sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text())["signing"]["publicKeyFingerprintSha256"])
PY
)"
grep -Fq "<txt-record>key=$key_sha</txt-record>" "$AVAHI_DIR/roomframe.service" || {
  printf '%s\n' "L'annonce Avahi ne contient pas l'empreinte signée." >&2
  exit 1
}
if grep -R -n -- 'PRIVATE KEY' "$DATA_DIR/pki/discovery"; then
  printf '%s\n' "Une clé privée a été publiée dans la découverte." >&2
  exit 1
fi

ROOMFRAME_RUNTIME_CONFIG="$CONFIG_DIR/runtime.conf" \
ROOMFRAME_AVAHI_SERVICE_DIR="$AVAHI_DIR" \
ROOMFRAME_SKIP_AVAHI_RELOAD=1 \
  "$ROOT/scripts/roomframe-refresh-discovery.sh" >/dev/null
identity_hash_after="$(sha256sum "$identity" | awk '{print $1}')"
[[ "$identity_hash_before" == "$identity_hash_after" ]] || {
  printf '%s\n' "L'identité de découverte a été régénérée." >&2
  exit 1
}

tampered="$TEST_ROOT/tampered.json"
python3 - "$manifest" "$tampered" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text())
value["fallbackOrigin"] = "https://192.0.2.25"
pathlib.Path(sys.argv[2]).write_text(json.dumps(value), encoding="utf-8")
PY
if "$ROOT/scripts/verify-discovery-manifest.py" "$tampered" >/dev/null 2>&1; then
  printf '%s\n' "Un manifeste de découverte altéré a été accepté." >&2
  exit 1
fi

printf '%s\n' "Test de découverte locale signée réussi."
