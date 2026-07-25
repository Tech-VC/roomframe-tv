#!/usr/bin/env python3
"""Recalcule le manifeste et reconstruit le bundle d'expérience neutre."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "defaults" / "experience"
OUTPUT = ROOT / "bundles" / "roomframe-default-experience-1.0.0.rfbundle"

files = []
for item in sorted(p for p in SOURCE.rglob("*") if p.is_file() and p.name != "manifest.json"):
    data = item.read_bytes()
    files.append({
        "path": item.relative_to(SOURCE).as_posix(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    })

manifest_path = SOURCE / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["files"] = files
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for item in sorted(p for p in SOURCE.rglob("*") if p.is_file()):
        archive.write(item, item.relative_to(SOURCE).as_posix())
print(OUTPUT)
