#!/usr/bin/env python3
"""Vérifie un bundle RoomFrame .rfupdate sans l'extraire.

Le manifeste UTF-8 est vérifié octet pour octet avec Ed25519. La clé publique
PEM est fournie explicitement; ce programme ne cherche et ne lit aucune clé
privée.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import uuid
import zipfile


SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?$"
)
PLAIN_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ARTIFACT_PATH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")
ALLOWED_ARTIFACT_KINDS = {
    "agent-apk",
    "home-apk",
    "server-archive",
    "oci-images",
    "migration",
    "compose-lock",
}
RESERVED_FILES = {"manifest.json", "manifest.sig"}
TOP_LEVEL_FIELDS = {
    "formatVersion",
    "releaseId",
    "version",
    "createdAt",
    "minimumServerVersion",
    "maximumServerVersion",
    "architectures",
    "signature",
    "artifacts",
    "migrations",
    "preservesInstanceData",
}


class VerificationError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="bundle .rfupdate à vérifier")
    parser.add_argument(
        "--trust-key",
        required=True,
        type=Path,
        help="clé publique Ed25519 PEM approuvée",
    )
    parser.add_argument(
        "--current-version",
        help="version serveur actuelle pour contrôler minimumServerVersion",
    )
    default_architecture = {
        "x86_64": "amd64",
        "AMD64": "amd64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }.get(platform.machine(), platform.machine())
    parser.add_argument(
        "--architecture",
        choices=("amd64", "arm64"),
        default=default_architecture if default_architecture in {"amd64", "arm64"} else None,
        help="architecture serveur à contrôler (défaut: architecture courante)",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=8 * 1024 * 1024 * 1024,
        help="taille décompressée cumulée maximale (défaut: 8 Gio)",
    )
    return parser.parse_args()


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"clé JSON dupliquée: {key}")
        result[key] = value
    return result


def validate_member_name(name: str, *, directory: bool) -> str:
    candidate = name[:-1] if directory and name.endswith("/") else name
    if (
        not candidate
        or candidate.startswith("/")
        or "\\" in candidate
        or "\x00" in candidate
        or ":" in candidate
    ):
        raise VerificationError(f"chemin ZIP non sûr: {name!r}")
    parts = candidate.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise VerificationError(f"chemin ZIP non canonique: {name!r}")
    normalized = PurePosixPath(candidate).as_posix()
    if normalized != candidate:
        raise VerificationError(f"chemin ZIP non canonique: {name!r}")
    return normalized


def inspect_archive(
    archive: zipfile.ZipFile, max_bytes: int
) -> dict[str, zipfile.ZipInfo]:
    members: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for info in archive.infolist():
        name = validate_member_name(info.filename, directory=info.is_dir())
        if name in members:
            raise VerificationError(f"entrée ZIP dupliquée: {name}")
        members[name] = info
        if info.flag_bits & 0x1:
            raise VerificationError(f"entrée ZIP chiffrée interdite: {name}")
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(unix_mode)
        if file_type == stat.S_IFLNK:
            raise VerificationError(f"lien symbolique ZIP interdit: {name}")
        if file_type and file_type not in {stat.S_IFREG, stat.S_IFDIR}:
            raise VerificationError(f"type de fichier ZIP interdit: {name}")
        if not info.is_dir():
            total_size += info.file_size
            if total_size > max_bytes:
                raise VerificationError("taille décompressée cumulée excessive")
            if (
                info.file_size > 1024 * 1024
                and (
                    info.compress_size == 0
                    or info.file_size / info.compress_size > 250
                )
            ):
                raise VerificationError(f"ratio de compression excessif: {name}")
    return members


def parse_semver(value: object, label: str) -> tuple[int, int, int, str | None]:
    if not isinstance(value, str):
        raise VerificationError(f"{label} doit être une chaîne SemVer")
    match = SEMVER_RE.fullmatch(value)
    if not match:
        raise VerificationError(f"{label} invalide: {value!r}")
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        match.group(4),
    )


def compare_semver(
    left: tuple[int, int, int, str | None],
    right: tuple[int, int, int, str | None],
) -> int:
    if left[:3] != right[:3]:
        return 1 if left[:3] > right[:3] else -1
    left_pre, right_pre = left[3], right[3]
    if left_pre == right_pre:
        return 0
    if left_pre is None:
        return 1
    if right_pre is None:
        return -1
    left_parts = left_pre.split(".")
    right_parts = right_pre.split(".")
    for left_part, right_part in zip(left_parts, right_parts):
        if left_part == right_part:
            continue
        left_numeric = left_part.isdigit()
        right_numeric = right_part.isdigit()
        if left_numeric and right_numeric:
            return 1 if int(left_part) > int(right_part) else -1
        if left_numeric != right_numeric:
            return -1 if left_numeric else 1
        return 1 if left_part > right_part else -1
    return (len(left_parts) > len(right_parts)) - (len(left_parts) < len(right_parts))


def parse_plain_version(value: object, label: str) -> tuple[int, int, int, None]:
    if not isinstance(value, str) or not PLAIN_VERSION_RE.fullmatch(value):
        raise VerificationError(f"{label} invalide: {value!r}")
    major, minor, patch = (int(part) for part in value.split("."))
    return major, minor, patch, None


def validate_manifest(
    manifest: object,
    current_version: str | None,
    architecture: str | None,
) -> list[dict]:
    if not isinstance(manifest, dict):
        raise VerificationError("manifest.json doit contenir un objet")
    required = {
        "formatVersion",
        "releaseId",
        "version",
        "createdAt",
        "artifacts",
        "preservesInstanceData",
        "signature",
    }
    missing = sorted(required - manifest.keys())
    if missing:
        raise VerificationError(f"champs du manifeste absents: {', '.join(missing)}")
    unexpected = sorted(manifest.keys() - TOP_LEVEL_FIELDS)
    if unexpected:
        raise VerificationError(f"champs du manifeste inconnus: {', '.join(unexpected)}")
    if manifest["formatVersion"] != 1:
        raise VerificationError("formatVersion non pris en charge")
    release_id = manifest["releaseId"]
    if not isinstance(release_id, str):
        raise VerificationError("releaseId doit être un UUID")
    try:
        uuid.UUID(release_id)
    except (ValueError, AttributeError) as error:
        raise VerificationError("releaseId doit être un UUID") from error
    release_version = parse_semver(manifest["version"], "version")
    created_at_value = manifest["createdAt"]
    if not isinstance(created_at_value, str):
        raise VerificationError("createdAt doit être une date ISO-8601")
    try:
        created_at = created_at_value.replace("Z", "+00:00")
        parsed_created_at = datetime.fromisoformat(created_at)
        if parsed_created_at.tzinfo is None:
            raise ValueError
    except ValueError as error:
        raise VerificationError("createdAt doit être une date ISO-8601") from error
    if manifest["preservesInstanceData"] is not True:
        raise VerificationError("preservesInstanceData doit être true")

    signature = manifest["signature"]
    if not isinstance(signature, dict):
        raise VerificationError("signature doit être un objet")
    if signature.get("algorithm") != "Ed25519":
        raise VerificationError("seule la signature Ed25519 est acceptée")
    key_id = signature.get("keyId")
    if set(signature) != {"algorithm", "keyId"}:
        raise VerificationError("signature contient des champs inconnus")
    if not isinstance(key_id, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{2,127}", key_id
    ):
        raise VerificationError("signature.keyId invalide")

    minimum = manifest.get("minimumServerVersion")
    maximum = manifest.get("maximumServerVersion")
    minimum_tuple = (
        parse_plain_version(minimum, "minimumServerVersion")
        if minimum is not None
        else None
    )
    maximum_tuple = (
        parse_plain_version(maximum, "maximumServerVersion")
        if maximum is not None
        else None
    )
    if minimum is not None:
        assert minimum_tuple is not None
    if minimum_tuple and maximum_tuple and compare_semver(minimum_tuple, maximum_tuple) > 0:
        raise VerificationError("plage de versions serveur incohérente")
    if current_version is not None:
        current_tuple = parse_semver(current_version, "current-version")
        if compare_semver(release_version, current_tuple) <= 0:
            raise VerificationError(
                f"la release {manifest['version']} n'est pas plus récente que {current_version}"
            )
        if minimum_tuple and compare_semver(current_tuple, minimum_tuple) < 0:
            raise VerificationError(
                f"serveur {current_version} incompatible; minimum requis {minimum}"
            )
        if maximum_tuple and compare_semver(current_tuple, maximum_tuple) > 0:
            raise VerificationError(
                f"serveur {current_version} incompatible; maximum accepté {maximum}"
            )

    architectures = manifest.get("architectures")
    if architectures is not None:
        if (
            not isinstance(architectures, list)
            or not architectures
            or len(architectures) != len(set(architectures))
            or any(value not in {"amd64", "arm64"} for value in architectures)
        ):
            raise VerificationError("architectures invalide")
        if architecture and architecture not in architectures:
            raise VerificationError(
                f"architecture {architecture} non prise en charge par la release"
            )

    migrations = manifest.get("migrations")
    if migrations is not None:
        if (
            not isinstance(migrations, list)
            or len(migrations) > 200
            or len(migrations) != len(set(migrations))
            or any(
                not isinstance(value, str)
                or not re.fullmatch(r"[0-9]{4}_[a-z0-9_]{1,100}", value)
                for value in migrations
            )
        ):
            raise VerificationError("migrations invalide")

    artifacts = manifest["artifacts"]
    if not isinstance(artifacts, list) or not artifacts or len(artifacts) > 1000:
        raise VerificationError("artifacts doit être une liste non vide")
    return artifacts


def decode_signature(value: bytes) -> bytes:
    if len(value) == 64:
        return value
    try:
        decoded = base64.b64decode(value.decode("ascii").strip(), validate=True)
    except (UnicodeDecodeError, ValueError) as error:
        raise VerificationError("manifest.sig n'est ni brut Ed25519 ni base64") from error
    if len(decoded) != 64:
        raise VerificationError("une signature Ed25519 doit faire 64 octets")
    return decoded


def verify_signature(manifest_bytes: bytes, signature: bytes, trust_key: Path) -> None:
    if not trust_key.is_file() or trust_key.is_symlink():
        raise VerificationError("la clé de confiance doit être un fichier PEM régulier")
    openssl = shutil.which("openssl")
    if openssl is None:
        raise VerificationError("openssl est requis pour vérifier Ed25519")
    with tempfile.TemporaryDirectory(prefix="roomframe-update-verify.") as directory:
        manifest_path = Path(directory, "manifest.json")
        signature_path = Path(directory, "manifest.sig")
        manifest_path.write_bytes(manifest_bytes)
        signature_path.write_bytes(signature)
        os.chmod(manifest_path, 0o600)
        os.chmod(signature_path, 0o600)
        result = subprocess.run(
            [
                openssl,
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                str(trust_key),
                "-rawin",
                "-in",
                str(manifest_path),
                "-sigfile",
                str(signature_path),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if result.returncode != 0:
        raise VerificationError("signature Ed25519 invalide")


def hash_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    digest = hashlib.sha256()
    with archive.open(info, "r") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify_artifacts(
    archive: zipfile.ZipFile,
    members: dict[str, zipfile.ZipInfo],
    artifacts: list[dict],
) -> None:
    listed: set[str] = set()
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            raise VerificationError(f"artifacts[{index}] doit être un objet")
        missing = {"path", "sha256", "size", "kind"} - artifact.keys()
        if missing:
            raise VerificationError(
                f"artifacts[{index}] incomplet: {', '.join(sorted(missing))}"
            )
        unexpected = set(artifact) - {"path", "sha256", "size", "kind"}
        if unexpected:
            raise VerificationError(
                f"artifacts[{index}] contient des champs inconnus: "
                f"{', '.join(sorted(unexpected))}"
            )
        raw_path = artifact["path"]
        if not isinstance(raw_path, str) or not ARTIFACT_PATH_RE.fullmatch(raw_path):
            raise VerificationError(f"chemin invalide pour artifacts[{index}]")
        path = validate_member_name(raw_path, directory=False)
        if path in RESERVED_FILES:
            raise VerificationError(f"artefact réservé interdit: {path}")
        if path in listed:
            raise VerificationError(f"artefact dupliqué dans le manifeste: {path}")
        listed.add(path)
        digest = artifact["sha256"]
        size = artifact["size"]
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise VerificationError(f"SHA-256 invalide pour {path}")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > 4_294_967_296
        ):
            raise VerificationError(f"taille invalide pour {path}")
        kind = artifact["kind"]
        if kind not in ALLOWED_ARTIFACT_KINDS:
            raise VerificationError(f"type d'artefact invalide pour {path}: {kind!r}")
        info = members.get(path)
        if info is None or info.is_dir():
            raise VerificationError(f"artefact absent du ZIP: {path}")
        if info.file_size != size:
            raise VerificationError(f"taille incorrecte pour {path}")
        if hash_member(archive, info) != digest:
            raise VerificationError(f"SHA-256 incorrect pour {path}")

    regular_files = {
        name for name, info in members.items() if not info.is_dir()
    }
    unlisted = sorted(regular_files - RESERVED_FILES - listed)
    if unlisted:
        raise VerificationError(
            f"fichiers ZIP non listés par le manifeste: {', '.join(unlisted)}"
        )


def main() -> int:
    args = parse_args()
    if args.max_bytes <= 0:
        raise VerificationError("--max-bytes doit être positif")
    if args.bundle.suffix != ".rfupdate":
        raise VerificationError("le bundle doit porter l'extension .rfupdate")
    if not args.bundle.is_file() or args.bundle.is_symlink():
        raise VerificationError("le bundle doit être un fichier régulier")

    try:
        with zipfile.ZipFile(args.bundle) as archive:
            members = inspect_archive(archive, args.max_bytes)
            if not RESERVED_FILES.issubset(members):
                raise VerificationError("manifest.json ou manifest.sig absent")
            if members["manifest.json"].file_size > 1024 * 1024:
                raise VerificationError("manifest.json dépasse 1 Mio")
            if members["manifest.sig"].file_size > 4096:
                raise VerificationError("manifest.sig est anormalement volumineux")
            manifest_bytes = archive.read(members["manifest.json"])
            try:
                manifest = json.loads(
                    manifest_bytes.decode("utf-8"),
                    object_pairs_hook=unique_object,
                )
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise VerificationError("manifest.json UTF-8/JSON invalide") from error
            artifacts = validate_manifest(
                manifest,
                args.current_version,
                args.architecture,
            )
            signature = decode_signature(archive.read(members["manifest.sig"]))
            verify_signature(manifest_bytes, signature, args.trust_key)
            verify_artifacts(archive, members, artifacts)
    except zipfile.BadZipFile as error:
        raise VerificationError("archive ZIP invalide") from error

    print(
        f"Bundle valide: {args.bundle.name} "
        f"(version {manifest['version']}, clé {manifest['signature']['keyId']})"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        raise SystemExit(f"Bundle refusé: {error}") from error
