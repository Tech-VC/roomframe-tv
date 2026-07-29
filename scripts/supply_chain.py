"""Validation partagée des métadonnées de chaîne de livraison RoomFrame."""

from __future__ import annotations

import datetime
import json
import re
import urllib.parse


MAX_SBOM_BYTES = 16 * 1024 * 1024
SPDX_ID = re.compile(r"^SPDXRef-[A-Za-z0-9.-]{1,200}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
RELATIONSHIP = re.compile(r"^[A-Z][A-Z0-9_]{1,80}$")


class SupplyChainError(ValueError):
    """Métadonnée SPDX absente, ambiguë ou incohérente."""


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise SupplyChainError(f"clé JSON SPDX dupliquée: {key}")
        result[key] = value
    return result


def parse_spdx_bytes(value: bytes) -> dict[str, object]:
    if not 2 <= len(value) <= MAX_SBOM_BYTES:
        raise SupplyChainError("SBOM SPDX hors limites")
    try:
        document = json.loads(
            value.decode("utf-8"),
            object_pairs_hook=unique_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SupplyChainError("SBOM SPDX UTF-8/JSON invalide") from error
    if not isinstance(document, dict):
        raise SupplyChainError("SBOM SPDX doit contenir un objet")
    return document


def _valid_utc_timestamp(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise SupplyChainError(f"{label} doit être une date UTC")
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise SupplyChainError(f"{label} est invalide") from error
    if parsed.tzinfo != datetime.timezone.utc:
        raise SupplyChainError(f"{label} doit être une date UTC")


def validate_spdx_document(
    document: object,
    *,
    release_version: str,
    server_archive_sha256: str,
) -> dict[str, object]:
    if not isinstance(document, dict):
        raise SupplyChainError("SBOM SPDX doit contenir un objet")
    if document.get("spdxVersion") != "SPDX-2.3":
        raise SupplyChainError("seul SPDX 2.3 est accepté")
    if document.get("dataLicense") != "CC0-1.0":
        raise SupplyChainError("dataLicense SPDX doit être CC0-1.0")
    if document.get("SPDXID") != "SPDXRef-DOCUMENT":
        raise SupplyChainError("SPDXID du document invalide")
    name = document.get("name")
    if not isinstance(name, str) or not 1 <= len(name) <= 256:
        raise SupplyChainError("nom du document SPDX invalide")
    namespace = document.get("documentNamespace")
    if not isinstance(namespace, str) or len(namespace) > 1024:
        raise SupplyChainError("namespace SPDX invalide")
    parsed_namespace = urllib.parse.urlsplit(namespace)
    if (
        parsed_namespace.scheme != "https"
        or not parsed_namespace.hostname
        or parsed_namespace.username is not None
        or parsed_namespace.password is not None
        or parsed_namespace.fragment
    ):
        raise SupplyChainError("namespace SPDX doit être une URL HTTPS sans secret")

    creation = document.get("creationInfo")
    if not isinstance(creation, dict):
        raise SupplyChainError("creationInfo SPDX absent")
    _valid_utc_timestamp(creation.get("created"), "creationInfo.created")
    creators = creation.get("creators")
    if (
        not isinstance(creators, list)
        or not creators
        or len(creators) > 20
        or any(not isinstance(value, str) or not 1 <= len(value) <= 256 for value in creators)
        or not any(
            value.startswith("Tool: RoomFrame SBOM Generator/")
            for value in creators
        )
    ):
        raise SupplyChainError("créateur RoomFrame du SBOM absent")

    packages = document.get("packages")
    if not isinstance(packages, list) or not 1 <= len(packages) <= 10_000:
        raise SupplyChainError("liste de packages SPDX invalide")
    package_ids: set[str] = set()
    root_package: dict[str, object] | None = None
    for index, package in enumerate(packages):
        if not isinstance(package, dict):
            raise SupplyChainError(f"packages[{index}] doit être un objet")
        package_id = package.get("SPDXID")
        package_name = package.get("name")
        if not isinstance(package_id, str) or not SPDX_ID.fullmatch(package_id):
            raise SupplyChainError(f"SPDXID invalide pour packages[{index}]")
        if package_id in package_ids:
            raise SupplyChainError(f"SPDXID de package dupliqué: {package_id}")
        package_ids.add(package_id)
        if not isinstance(package_name, str) or not 1 <= len(package_name) <= 512:
            raise SupplyChainError(f"nom invalide pour packages[{index}]")
        if not isinstance(package.get("downloadLocation"), str):
            raise SupplyChainError(f"downloadLocation absent pour {package_id}")
        if not isinstance(package.get("filesAnalyzed"), bool):
            raise SupplyChainError(f"filesAnalyzed absent pour {package_id}")
        if package_id == "SPDXRef-Package-RoomFrame":
            root_package = package

    if root_package is None:
        raise SupplyChainError("package racine RoomFrame absent du SBOM")
    if (
        root_package.get("name") != "roomframe-tv"
        or root_package.get("versionInfo") != release_version
        or root_package.get("filesAnalyzed") is not False
    ):
        raise SupplyChainError("package racine RoomFrame incohérent")
    if not SHA256.fullmatch(server_archive_sha256):
        raise SupplyChainError("SHA-256 attendu de l'archive serveur invalide")
    checksums = root_package.get("checksums")
    if not isinstance(checksums, list) or not any(
        isinstance(checksum, dict)
        and checksum.get("algorithm") == "SHA256"
        and checksum.get("checksumValue") == server_archive_sha256
        for checksum in checksums
    ):
        raise SupplyChainError("le SBOM ne référence pas l'archive serveur exacte")

    describes = document.get("documentDescribes")
    if (
        not isinstance(describes, list)
        or "SPDXRef-Package-RoomFrame" not in describes
    ):
        raise SupplyChainError("documentDescribes ne référence pas RoomFrame")

    relationships = document.get("relationships")
    if not isinstance(relationships, list) or not 1 <= len(relationships) <= 20_000:
        raise SupplyChainError("relations SPDX invalides")
    described = False
    known_ids = package_ids | {"SPDXRef-DOCUMENT"}
    for index, relationship in enumerate(relationships):
        if not isinstance(relationship, dict):
            raise SupplyChainError(f"relationships[{index}] doit être un objet")
        source = relationship.get("spdxElementId")
        target = relationship.get("relatedSpdxElement")
        kind = relationship.get("relationshipType")
        if (
            source not in known_ids
            or target not in known_ids
            or not isinstance(kind, str)
            or not RELATIONSHIP.fullmatch(kind)
        ):
            raise SupplyChainError(f"relation SPDX invalide à l'index {index}")
        if (
            source == "SPDXRef-DOCUMENT"
            and target == "SPDXRef-Package-RoomFrame"
            and kind == "DESCRIBES"
        ):
            described = True
    if not described:
        raise SupplyChainError("relation DESCRIBES du package RoomFrame absente")
    return document
