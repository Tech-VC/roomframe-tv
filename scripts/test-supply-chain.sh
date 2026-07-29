#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for command_name in openssl python3 tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Dépendance de test supply-chain absente: %s\n' "$command_name" >&2
    exit 1
  }
done

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/roomframe-supply-chain-test.XXXXXX")"
cleanup() {
  if [[ -d "$TEST_ROOT" && ! -L "$TEST_ROOT" ]]; then
    find "$TEST_ROOT" -xdev -depth -mindepth 1 -delete 2>/dev/null || true
    rmdir "$TEST_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$TEST_ROOT/source/database/migrations"
cp "$ROOT"/database/migrations/*.sql "$TEST_ROOT/source/database/migrations/"
printf '%s\n' "RoomFrame supply-chain test" >"$TEST_ROOT/source/README"
COPYFILE_DISABLE=1 tar -czf "$TEST_ROOT/server.tar.gz" -C "$TEST_ROOT/source" .

private_key="$TEST_ROOT/release-private.pem"
public_key="$TEST_ROOT/release-public.pem"
openssl genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
chmod 0600 "$private_key"
openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1

revision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
sbom="$TEST_ROOT/roomframe-0.4.0.spdx.json"
bundle="$TEST_ROOT/roomframe-0.4.0.rfupdate"
python3 "$ROOT/scripts/build-sbom.py" \
  --root "$ROOT" \
  --version 0.4.0 \
  --source-archive "$TEST_ROOT/server.tar.gz" \
  --source-repository example/roomframe \
  --source-revision "$revision" \
  --created-at 2026-07-29T12:00:00Z \
  --output "$sbom" >/dev/null
python3 "$ROOT/scripts/build-signed-update.py" \
  --artifact "$TEST_ROOT/server.tar.gz" \
  --sbom "$sbom" \
  --source-repository example/roomframe \
  --source-revision "$revision" \
  --source-ref refs/tags/v0.4.0 \
  --version 0.4.0 \
  --private-key "$private_key" \
  --key-id test-supply-chain \
  --migrations-dir "$ROOT/database/migrations" \
  --output "$bundle" >/dev/null
python3 "$ROOT/scripts/verify-update-bundle.py" \
  "$bundle" \
  --trust-key "$public_key" \
  --current-version 0.3.0 >/dev/null

python3 - "$bundle" "$revision" <<'PY'
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["source"] == {
        "provider": "github",
        "repository": "example/roomframe",
        "revision": sys.argv[2],
        "ref": "refs/tags/v0.4.0",
    }
    sboms = [
        artifact for artifact in manifest["artifacts"]
        if artifact["kind"] == "sbom-spdx"
    ]
    assert len(sboms) == 1
    sbom = json.loads(archive.read(sboms[0]["path"]))
    assert sbom["spdxVersion"] == "SPDX-2.3"
    assert len(sbom["packages"]) > 10
PY

invalid_sbom="$TEST_ROOT/invalid.spdx.json"
python3 - "$sbom" "$invalid_sbom" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
root = next(
    package for package in value["packages"]
    if package["SPDXID"] == "SPDXRef-Package-RoomFrame"
)
root["versionInfo"] = "9.9.9"
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(value, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
PY
if python3 "$ROOT/scripts/build-signed-update.py" \
  --artifact "$TEST_ROOT/server.tar.gz" \
  --sbom "$invalid_sbom" \
  --source-repository example/roomframe \
  --source-revision "$revision" \
  --source-ref refs/tags/v0.4.0 \
  --version 0.4.0 \
  --private-key "$private_key" \
  --key-id test-supply-chain \
  --migrations-dir "$ROOT/database/migrations" \
  --output "$TEST_ROOT/invalid.rfupdate" >/dev/null 2>&1; then
  printf '%s\n' "Un SBOM incohérent a été signé." >&2
  exit 1
fi

if python3 "$ROOT/scripts/build-signed-update.py" \
  --artifact "$TEST_ROOT/server.tar.gz" \
  --sbom "$sbom" \
  --source-repository example/roomframe \
  --source-revision "$revision" \
  --source-ref refs/tags/v0.4.1 \
  --version 0.4.0 \
  --private-key "$private_key" \
  --key-id test-supply-chain \
  --migrations-dir "$ROOT/database/migrations" \
  --output "$TEST_ROOT/wrong-ref.rfupdate" >/dev/null 2>&1; then
  printf '%s\n' "Une ref Git incohérente a été signée." >&2
  exit 1
fi

printf '%s\n' "Test SBOM SPDX et provenance signée réussi."
