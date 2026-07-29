#!/usr/bin/env python3
"""Vérifie strictement un manifeste RoomFrame de découverte locale signé."""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse


HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
DNS_NAME = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--expected-ip")
    parser.add_argument("--expected-host")
    parser.add_argument("--expected-ca-sha256")
    return parser.parse_args()


def decode_base64url(value: object, label: str, minimum: int, maximum: int) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise SystemExit(f"{label} n'est pas un base64url canonique")
    padding = "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(value + padding)
    except ValueError as error:
        raise SystemExit(f"{label} est invalide") from error
    if not minimum <= len(decoded) <= maximum:
        raise SystemExit(f"{label} est hors limites")
    if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
        raise SystemExit(f"{label} n'est pas canonique")
    return decoded


def validate_origin(value: object, expected_host: str, label: str) -> str:
    if not isinstance(value, str):
        raise SystemExit(f"{label} doit être une URL")
    parsed = urllib.parse.urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise SystemExit(f"{label} contient un port invalide") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected_host
        or port not in {None, 443}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit(f"{label} n'est pas une origine HTTPS RoomFrame")
    return f"https://{parsed.hostname}"


def main() -> int:
    args = parse_args()
    if not args.manifest.is_file() or args.manifest.is_symlink():
        raise SystemExit("le manifeste doit être un fichier régulier")
    if args.manifest.stat().st_size > 32 * 1024:
        raise SystemExit("le manifeste est trop volumineux")
    try:
        descriptor = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"manifeste JSON invalide: {error}") from error
    if not isinstance(descriptor, dict) or set(descriptor) != {
        "formatVersion",
        "serviceType",
        "path",
        "origin",
        "fallbackOrigin",
        "host",
        "ipv4",
        "port",
        "serverCaFingerprintSha256",
        "generatedAt",
        "signing",
    }:
        raise SystemExit("clés du manifeste de découverte invalides")
    if (
        descriptor["formatVersion"] != 1
        or descriptor["serviceType"] != "_roomframe._tcp"
        or descriptor["path"] != "/api/v1/discovery"
        or descriptor["port"] != 443
    ):
        raise SystemExit("version ou service de découverte incompatible")

    host = descriptor["host"]
    if not isinstance(host, str) or len(host) > 253 or (
        not DNS_NAME.fullmatch(host) and host != descriptor["ipv4"]
    ):
        raise SystemExit("hôte de découverte invalide")
    try:
        ipv4 = str(ipaddress.IPv4Address(descriptor["ipv4"]))
    except (ipaddress.AddressValueError, TypeError) as error:
        raise SystemExit("IPv4 de découverte invalide") from error
    if descriptor["ipv4"] != ipv4:
        raise SystemExit("IPv4 de découverte non canonique")
    validate_origin(descriptor["origin"], host, "origin")
    validate_origin(descriptor["fallbackOrigin"], ipv4, "fallbackOrigin")
    if args.expected_ip and ipv4 != str(ipaddress.IPv4Address(args.expected_ip)):
        raise SystemExit("IPv4 différente de l'instance attendue")
    if args.expected_host and host != args.expected_host.lower().rstrip("."):
        raise SystemExit("hôte différent de l'instance attendue")

    ca_sha = descriptor["serverCaFingerprintSha256"]
    if not isinstance(ca_sha, str) or not HEX_SHA256.fullmatch(ca_sha):
        raise SystemExit("empreinte de CA HTTPS invalide")
    if args.expected_ca_sha256 and ca_sha != args.expected_ca_sha256.lower():
        raise SystemExit("empreinte de CA HTTPS inattendue")
    generated_at = descriptor["generatedAt"]
    if not isinstance(generated_at, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z",
        generated_at,
    ):
        raise SystemExit("date de génération invalide")
    try:
        parsed_generated_at = datetime.datetime.fromisoformat(
            generated_at.removesuffix("Z") + "+00:00"
        )
    except ValueError as error:
        raise SystemExit("date de génération invalide") from error
    if parsed_generated_at.tzinfo != datetime.timezone.utc:
        raise SystemExit("date de génération non UTC")

    signing = descriptor["signing"]
    if not isinstance(signing, dict) or set(signing) != {
        "algorithm",
        "publicKeySpki",
        "publicKeyFingerprintSha256",
        "signature",
    }:
        raise SystemExit("bloc de signature invalide")
    if signing["algorithm"] != "ECDSA-P256-SHA256":
        raise SystemExit("algorithme de découverte incompatible")
    public_der = decode_base64url(signing["publicKeySpki"], "clé publique", 80, 200)
    signature = decode_base64url(signing["signature"], "signature", 64, 80)
    key_sha = signing["publicKeyFingerprintSha256"]
    if (
        not isinstance(key_sha, str)
        or not HEX_SHA256.fullmatch(key_sha)
        or hashlib.sha256(public_der).hexdigest() != key_sha
    ):
        raise SystemExit("empreinte de clé publique invalide")

    signed = json.loads(json.dumps(descriptor))
    del signed["signing"]["signature"]
    canonical = json.dumps(
        signed,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    with tempfile.TemporaryDirectory(prefix="roomframe-discovery-verify.") as temporary:
        root = Path(temporary)
        public_der_path = root / "public.der"
        public_pem_path = root / "public.pem"
        signature_path = root / "signature.bin"
        canonical_path = root / "canonical.bin"
        public_der_path.write_bytes(public_der)
        signature_path.write_bytes(signature)
        canonical_path.write_bytes(canonical)
        subprocess.run(
            [
                "openssl",
                "pkey",
                "-pubin",
                "-inform",
                "DER",
                "-in",
                str(public_der_path),
                "-out",
                str(public_pem_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        details = subprocess.run(
            [
                "openssl",
                "pkey",
                "-pubin",
                "-in",
                str(public_pem_path),
                "-text_pub",
                "-noout",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if "ASN1 OID: prime256v1" not in details:
            raise SystemExit("la clé publique n'utilise pas ECDSA P-256")
        result = subprocess.run(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-verify",
                str(public_pem_path),
                "-signature",
                str(signature_path),
                str(canonical_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            raise SystemExit("signature du manifeste de découverte invalide")
    print(f"Manifeste de découverte valide: {key_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
