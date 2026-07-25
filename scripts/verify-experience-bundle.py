#!/usr/bin/env python3
from __future__ import annotations
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

bundle = Path(sys.argv[1] if len(sys.argv) > 1 else "bundles/roomframe-default-experience-1.0.0.rfbundle")
with zipfile.ZipFile(bundle) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise SystemExit("Le bundle contient un chemin dupliqué.")
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        mode = info.external_attr >> 16
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in info.filename
            or stat.S_ISLNK(mode)
        ):
            raise SystemExit(f"Chemin ou type interdit: {info.filename}")
    manifest = json.loads(archive.read("manifest.json"))
    listed = {entry["path"] for entry in manifest["files"]}
    if len(listed) != len(manifest["files"]):
        raise SystemExit("Le manifeste contient un chemin dupliqué.")
    entrypoints = set(manifest["entrypoints"].values())
    missing_entrypoints = entrypoints - listed
    if missing_entrypoints:
        raise SystemExit(f"Entrées non hachées: {sorted(missing_entrypoints)}")
    regular = {info.filename for info in archive.infolist() if not info.is_dir()}
    unexpected = regular - listed - {"manifest.json"}
    missing = listed - regular
    if unexpected or missing:
        raise SystemExit(
            f"Ensemble de fichiers invalide; inattendus={sorted(unexpected)}, absents={sorted(missing)}"
        )
    for entry in manifest["files"]:
        data = archive.read(entry["path"])
        if len(data) != entry["size"]:
            raise SystemExit(f"Taille invalide: {entry['path']}")
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise SystemExit(f"SHA-256 invalide: {entry['path']}")
    for entrypoint in entrypoints:
        json.loads(archive.read(entrypoint))
print(f"Bundle valide: {bundle}")
