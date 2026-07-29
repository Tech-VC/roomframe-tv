#!/usr/bin/env python3
"""Construit le SBOM SPDX 2.3 d'une release RoomFrame depuis ses verrous."""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True

from supply_chain import SupplyChainError, validate_spdx_document


SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?$"
)
REPOSITORY = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$"
)
REVISION = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
GRADLE_COORDINATE = re.compile(
    r'(?:implementation|testImplementation)\("'
    r"([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([^\"\\]+)\"\)"
)
GRADLE_PLUGIN = re.compile(
    r'id\("([A-Za-z0-9_.-]+)"\)\s+version\s+"([^\"\\]+)"'
)
PINNED_IMAGE = re.compile(
    r"(?:image:\s*|FROM\s+)([A-Za-z0-9./_-]+:[A-Za-z0-9._-]+)"
    r"@sha256:([a-f0-9]{64})"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-archive", required=True, type=Path)
    parser.add_argument("--source-repository", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--created-at")
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def sha256_file(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def package_id(prefix: str, locator: str) -> str:
    digest = hashlib.sha256(locator.encode()).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9.-]", "-", prefix).strip("-.")[:80] or "Package"
    return f"SPDXRef-{safe}-{digest}"


def safe_download_location(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        return "NOASSERTION"
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return "NOASSERTION"
    return value


def package_license(value: object) -> str:
    if (
        isinstance(value, str)
        and 1 <= len(value) <= 200
        and re.fullmatch(r"[A-Za-z0-9.+() -]+", value)
    ):
        return value
    return "NOASSERTION"


def checksum_from_integrity(value: object) -> list[dict[str, str]]:
    if not isinstance(value, str):
        return []
    for candidate in value.split():
        if not candidate.startswith("sha512-"):
            continue
        try:
            decoded = base64.b64decode(candidate.removeprefix("sha512-"), validate=True)
        except ValueError:
            continue
        if len(decoded) == 64:
            return [{"algorithm": "SHA512", "checksumValue": decoded.hex()}]
    return []


def npm_packages(root: Path) -> list[dict[str, object]]:
    lock_path = root / "services/api/package-lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"package-lock.json invalide: {error}") from error
    if lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
        raise SystemExit("package-lock.json v3 requis pour le SBOM")
    result = []
    for locator, package in sorted(lock["packages"].items()):
        if not locator or not isinstance(package, dict):
            continue
        version = package.get("version")
        if not isinstance(version, str) or not version:
            raise SystemExit(f"version npm absente: {locator}")
        name = package.get("name")
        if not isinstance(name, str) or not name:
            name = locator.rsplit("node_modules/", 1)[-1]
        spdx_id = package_id("NPM", f"{locator}\0{name}\0{version}")
        entry: dict[str, object] = {
            "name": name,
            "SPDXID": spdx_id,
            "versionInfo": version,
            "downloadLocation": safe_download_location(package.get("resolved")),
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": package_license(package.get("license")),
            "copyrightText": "NOASSERTION",
            "primaryPackagePurpose": "LIBRARY",
            "externalRefs": [{
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": (
                    "pkg:npm/"
                    f"{urllib.parse.quote(name, safe='/')}@"
                    f"{urllib.parse.quote(version, safe='')}"
                ),
            }],
        }
        checksums = checksum_from_integrity(package.get("integrity"))
        if checksums:
            entry["checksums"] = checksums
        if package.get("dev") is True:
            entry["comment"] = "Dépendance de développement selon package-lock.json."
        if package.get("optional") is True:
            entry["comment"] = (
                f"{entry.get('comment', '')} Dépendance optionnelle."
            ).strip()
        result.append(entry)
    return result


def gradle_packages(root: Path) -> list[dict[str, object]]:
    sources = [
        root / "apps/tv-android/build.gradle.kts",
        root / "apps/tv-android/app/build.gradle.kts",
    ]
    coordinates: set[tuple[str, str, str, str]] = set()
    for source in sources:
        try:
            text = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SystemExit(f"configuration Gradle illisible: {source}") from error
        for group, artifact, version in GRADLE_COORDINATE.findall(text):
            scope = "test" if f'testImplementation("{group}:{artifact}:{version}")' in text else "build"
            coordinates.add((group, artifact, version, scope))
        for plugin, version in GRADLE_PLUGIN.findall(text):
            coordinates.add(("gradle-plugin", plugin, version, "build"))
    wrapper = root / "apps/tv-android/gradle/wrapper/gradle-wrapper.properties"
    wrapper_text = wrapper.read_text(encoding="utf-8")
    wrapper_version = re.search(r"gradle-([0-9][0-9.]*)-bin\.zip", wrapper_text)
    wrapper_sha = re.search(r"distributionSha256Sum=([a-f0-9]{64})", wrapper_text)
    if not wrapper_version or not wrapper_sha:
        raise SystemExit("wrapper Gradle non épinglé")
    coordinates.add(("gradle", "gradle-wrapper", wrapper_version.group(1), "build"))

    packages = []
    for group, artifact, version, scope in sorted(coordinates):
        locator = f"{group}:{artifact}:{version}"
        entry: dict[str, object] = {
            "name": f"{group}:{artifact}",
            "SPDXID": package_id("Gradle", locator),
            "versionInfo": version,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
            "primaryPackagePurpose": "LIBRARY",
            "comment": f"Dépendance Android/Gradle de portée {scope}.",
            "externalRefs": [{
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": (
                    f"pkg:maven/{urllib.parse.quote(group, safe='.')}/"
                    f"{urllib.parse.quote(artifact, safe='')}@"
                    f"{urllib.parse.quote(version, safe='')}"
                ),
            }],
        }
        if group == "gradle" and artifact == "gradle-wrapper":
            entry["checksums"] = [{
                "algorithm": "SHA256",
                "checksumValue": wrapper_sha.group(1),
            }]
        packages.append(entry)
    return packages


def image_packages(root: Path) -> list[dict[str, object]]:
    images: set[tuple[str, str]] = set()
    for source in (root / "compose.yaml", root / "services/api/Dockerfile"):
        text = source.read_text(encoding="utf-8")
        images.update(PINNED_IMAGE.findall(text))
    result = []
    for image, digest in sorted(images):
        result.append({
            "name": image,
            "SPDXID": package_id("OCI", f"{image}@sha256:{digest}"),
            "versionInfo": image.rsplit(":", 1)[-1],
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
            "primaryPackagePurpose": "CONTAINER",
            "checksums": [{"algorithm": "SHA256", "checksumValue": digest}],
            "comment": "Image OCI épinglée par digest dans les sources RoomFrame.",
        })
    return result


def normalize_created_at(value: str | None) -> str:
    if value is None:
        epoch = os.environ.get("SOURCE_DATE_EPOCH")
        if epoch:
            parsed = datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc)
        else:
            parsed = datetime.datetime.now(datetime.timezone.utc)
    else:
        try:
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise SystemExit("--created-at doit être une date ISO-8601") from error
        if parsed.tzinfo is None:
            raise SystemExit("--created-at doit contenir un fuseau")
        parsed = parsed.astimezone(datetime.timezone.utc)
    return parsed.isoformat().replace("+00:00", "Z")


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if not SEMVER.fullmatch(args.version):
        raise SystemExit("--version doit être une version SemVer")
    repository = args.source_repository.lower()
    revision = args.source_revision.lower()
    if not REPOSITORY.fullmatch(repository):
        raise SystemExit("--source-repository doit être de la forme owner/repo")
    if not REVISION.fullmatch(revision):
        raise SystemExit("--source-revision doit être un SHA Git de 40 ou 64 hex")
    if not args.source_archive.is_file() or args.source_archive.is_symlink():
        raise SystemExit("--source-archive doit être un fichier régulier")
    if args.output.exists() and args.output.is_symlink():
        raise SystemExit("--output ne peut pas être un lien symbolique")

    archive_sha = sha256_file(args.source_archive)
    packages = npm_packages(root) + gradle_packages(root) + image_packages(root)
    root_package = {
        "name": "roomframe-tv",
        "SPDXID": "SPDXRef-Package-RoomFrame",
        "versionInfo": args.version,
        "packageFileName": args.source_archive.name,
        "downloadLocation": f"git+https://github.com/{repository}.git@{revision}",
        "filesAnalyzed": False,
        "licenseConcluded": "Apache-2.0",
        "licenseDeclared": "Apache-2.0",
        "copyrightText": "Copyright 2026 RoomFrame TV contributors",
        "primaryPackagePurpose": "APPLICATION",
        "checksums": [{"algorithm": "SHA256", "checksumValue": archive_sha}],
        "externalRefs": [{
            "referenceCategory": "PACKAGE-MANAGER",
            "referenceType": "purl",
            "referenceLocator": f"pkg:github/{repository}@{revision}",
        }],
    }
    package_ids = [package["SPDXID"] for package in packages]
    namespace_id = hashlib.sha256(
        f"{repository}\0{revision}\0{args.version}\0{archive_sha}".encode()
    ).hexdigest()
    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"RoomFrame TV {args.version}",
        "documentNamespace": (
            f"https://roomframe.example/spdx/roomframe-tv/"
            f"{args.version}/{namespace_id}"
        ),
        "creationInfo": {
            "created": normalize_created_at(args.created_at),
            "creators": [
                "Tool: RoomFrame SBOM Generator/1",
                "Organization: RoomFrame TV contributors",
            ],
            "comment": (
                "Inventaire déterministe des verrous npm/Gradle et des images "
                "OCI épinglées; ce document n'est pas un rapport de vulnérabilités."
            ),
        },
        "documentDescribes": ["SPDXRef-Package-RoomFrame"],
        "packages": [root_package, *packages],
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": "SPDXRef-Package-RoomFrame",
            },
            *[
                {
                    "spdxElementId": "SPDXRef-Package-RoomFrame",
                    "relationshipType": "DEPENDS_ON",
                    "relatedSpdxElement": package_id_value,
                }
                for package_id_value in package_ids
            ],
        ],
    }
    try:
        validate_spdx_document(
            document,
            release_version=args.version,
            server_archive_sha256=archive_sha,
        )
    except SupplyChainError as error:
        raise SystemExit(f"SBOM généré invalide: {error}") from error

    args.output.parent.mkdir(parents=True, exist_ok=True)
    serialized = (
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode()
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix=f".{args.output.name}.",
        suffix=".part",
        dir=args.output.parent,
    )
    try:
        with os.fdopen(temporary_fd, "wb") as target:
            target.write(serialized)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, args.output)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    print(
        f"SBOM SPDX 2.3: {args.output} "
        f"({len(packages) + 1} packages, SHA-256 {sha256_file(args.output)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
