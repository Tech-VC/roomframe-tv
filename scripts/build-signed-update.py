#!/usr/bin/env python3
"""Construit un bundle RoomFrame .rfupdate signé avec une clé Ed25519 externe."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile
import uuid
import zipfile


SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?$"
)
KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$")
MIGRATION_RE = re.compile(r"^[0-9]{4}_[a-z0-9_]+\.sql$")
SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
ANDROID_PACKAGE_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifact",
        type=Path,
        help="archive serveur .tar.gz (optionnelle si --home-apk est fourni)",
    )
    parser.add_argument("--home-apk", type=Path, help="APK RoomFrame Home signé")
    parser.add_argument("--home-package", help="package Android de --home-apk")
    parser.add_argument("--home-version-code", type=int, help="versionCode Android")
    parser.add_argument(
        "--home-signing-cert-sha256",
        help="SHA-256 du certificat de signature de l'APK",
    )
    parser.add_argument("--version", required=True)
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--migrations-dir",
        type=Path,
        default=Path("database/migrations"),
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path, label: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"{label} doit être un fichier régulier: {path}")


def validate_server_archive(path: Path, expected_migrations: set[str]) -> None:
    actual_migrations: set[str] = set()
    seen: set[str] = set()
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for member in archive.getmembers():
                name = member.name
                while name.startswith("./"):
                    name = name[2:]
                if name in {"", "."} and member.isdir():
                    continue
                relative = PurePosixPath(name)
                if (
                    relative.is_absolute()
                    or not relative.parts
                    or any(part in {"", ".", ".."} for part in relative.parts)
                    or relative.as_posix() in seen
                    or not (member.isfile() or member.isdir())
                ):
                    raise SystemExit(
                        f"Entrée non sûre dans l'archive serveur: {member.name!r}"
                    )
                seen.add(relative.as_posix())
                if relative.name == ".DS_Store" or relative.name.startswith("._"):
                    raise SystemExit(
                        "Métadonnée macOS interdite dans l'archive serveur; "
                        "reconstruire le tar avec COPYFILE_DISABLE=1."
                    )
                if (
                    member.isfile()
                    and relative.parts[:-1] == ("database", "migrations")
                    and MIGRATION_RE.fullmatch(relative.name)
                ):
                    actual_migrations.add(relative.stem)
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f"Archive serveur tar.gz invalide: {error}") from error
    if actual_migrations != expected_migrations:
        raise SystemExit(
            "Les migrations de l'archive serveur diffèrent de --migrations-dir."
        )


def main() -> int:
    args = parse_args()
    if args.artifact is None and args.home_apk is None:
        raise SystemExit("Fournir au moins --artifact ou --home-apk.")
    if args.artifact is not None:
        regular_file(args.artifact, "L'archive serveur")
    if args.home_apk is not None:
        regular_file(args.home_apk, "L'APK RoomFrame Home")
        if not ANDROID_PACKAGE_RE.fullmatch(args.home_package or ""):
            raise SystemExit("--home-package doit être un nom de package Android valide.")
        if args.home_version_code is None or not 1 <= args.home_version_code <= 2_147_483_647:
            raise SystemExit("--home-version-code doit être compris entre 1 et 2147483647.")
        if not SHA256_RE.fullmatch(args.home_signing_cert_sha256 or ""):
            raise SystemExit("--home-signing-cert-sha256 doit contenir 64 caractères hexadécimaux.")
    elif any(
        value is not None
        for value in (
            args.home_package,
            args.home_version_code,
            args.home_signing_cert_sha256,
        )
    ):
        raise SystemExit("Les métadonnées --home-* nécessitent --home-apk.")
    regular_file(args.private_key, "La clé privée")
    if not SEMVER_RE.fullmatch(args.version):
        raise SystemExit(f"Version SemVer invalide: {args.version}")
    if not KEY_ID_RE.fullmatch(args.key_id):
        raise SystemExit(f"Identifiant de clé invalide: {args.key_id}")
    private_mode = stat.S_IMODE(args.private_key.stat().st_mode)
    if private_mode & 0o077:
        raise SystemExit("La clé privée doit être accessible uniquement à son propriétaire (0600).")
    if args.output.suffix != ".rfupdate":
        raise SystemExit("Le fichier de sortie doit porter l'extension .rfupdate")
    if args.output.exists() and args.output.is_symlink():
        raise SystemExit("Le fichier de sortie ne peut pas être un lien symbolique")

    migrations = []
    if args.migrations_dir.is_dir():
        migrations = sorted(
            path.stem
            for path in args.migrations_dir.iterdir()
            if path.is_file() and MIGRATION_RE.fullmatch(path.name)
        )
    if args.artifact is not None:
        validate_server_archive(args.artifact, set(migrations))

    artifact_specs: list[tuple[Path, str, dict[str, object]]] = []
    if args.artifact is not None:
        artifact_name = f"server/roomframe-server-{args.version}.tar.gz"
        artifact_specs.append(
            (
                args.artifact,
                artifact_name,
                {
                    "path": artifact_name,
                    "sha256": sha256_file(args.artifact),
                    "size": args.artifact.stat().st_size,
                    "kind": "server-archive",
                },
            )
        )
    if args.home_apk is not None:
        apk_name = f"android/roomframe-home-{args.version}.apk"
        artifact_specs.append(
            (
                args.home_apk,
                apk_name,
                {
                    "path": apk_name,
                    "sha256": sha256_file(args.home_apk),
                    "size": args.home_apk.stat().st_size,
                    "kind": "home-apk",
                    "packageName": args.home_package,
                    "versionCode": args.home_version_code,
                    "signingCertificateSha256": args.home_signing_cert_sha256.lower(),
                },
            )
        )
    manifest = {
        "formatVersion": 1,
        "releaseId": str(uuid.uuid4()),
        "version": args.version,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "minimumServerVersion": "0.3.0",
        "signature": {
            "algorithm": "Ed25519",
            "keyId": args.key_id,
        },
        "artifacts": [descriptor for _, _, descriptor in artifact_specs],
        "migrations": migrations,
        "preservesInstanceData": True,
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="roomframe-sign-update.") as temporary_dir:
        temporary = Path(temporary_dir)
        manifest_path = temporary / "manifest.json"
        signature_path = temporary / "manifest.sig"
        manifest_path.write_bytes(manifest_bytes)
        os.chmod(manifest_path, 0o600)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-inkey",
                str(args.private_key),
                "-rawin",
                "-in",
                str(manifest_path),
                "-out",
                str(signature_path),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(f"Signature Ed25519 impossible: {result.stderr.strip()}")
        signature = signature_path.read_bytes()
        if len(signature) != 64:
            raise SystemExit("La signature Ed25519 produite ne fait pas 64 octets.")

        staged = args.output.parent / (
            f".{args.output.name}.{os.getpid()}.{uuid.uuid4().hex}.part"
        )
        try:
            with zipfile.ZipFile(
                staged,
                mode="x",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=9,
                allowZip64=True,
            ) as archive:
                archive.writestr("manifest.json", manifest_bytes, compress_type=zipfile.ZIP_STORED)
                archive.writestr("manifest.sig", signature, compress_type=zipfile.ZIP_STORED)
                for source, archive_name, _ in artifact_specs:
                    archive.write(source, archive_name)
            os.chmod(staged, 0o644)
            os.replace(staged, args.output)
        finally:
            try:
                staged.unlink()
            except FileNotFoundError:
                pass

    print(
        f"Bundle signé: {args.output} "
        f"(version {args.version}, SHA-256 {sha256_file(args.output)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
