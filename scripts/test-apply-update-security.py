#!/usr/bin/env python3
"""Exercise the privileged update boundary with fake Docker and no deployment."""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent.parent


def server_archive(label: str) -> bytes:
    files = {
        "install.sh": 'ROOMFRAME_VERSION="0.4.0"\n',
        "compose.yaml": "services: {}\n",
        "infra/Caddyfile": "# test fixture\n",
        "scripts/source-excludes.txt": "# test fixture\n",
        "scripts/roomframe-apply-update.sh": "# test fixture\n",
        "services/api/package.json": '{"version":"0.4.0"}\n',
        "defaults/experience/manifest.json": "{}\n",
        "build-label.txt": label,
    }
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, text in files.items():
            data = text.encode()
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


@unittest.skipUnless(os.geteuid() == 0, "privileged update test requires root")
class UpdateSnapshotSecurityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="roomframe-update-test.")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.install = self.base / "install"
        self.data = self.base / "data"
        self.bin = self.base / "bin"
        self.verified = self.data / "releases/verified"
        self.trust = self.data / "pki/update-trust"
        for directory in (self.install, self.bin, self.verified, self.trust):
            directory.mkdir(parents=True)
        private_key = self.base / "private.pem"
        public_key = self.trust / "test-snapshot.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", private_key],
            check=True, capture_output=True,
        )
        private_key.chmod(0o600)
        subprocess.run(
            ["openssl", "pkey", "-in", private_key, "-pubout", "-out", public_key],
            check=True, capture_output=True,
        )
        artifact = self.base / "server.tar.gz"
        artifact.write_bytes(server_archive("trusted"))
        bundle = self.base / "original.rfupdate"
        subprocess.run(
            [sys.executable, ROOT / "scripts/build-signed-update.py",
             "--artifact", artifact, "--version", "0.4.0",
             "--private-key", private_key, "--key-id", "test-snapshot",
             "--migrations-dir", self.base / "empty-migrations",
             "--output", bundle],
            check=True, capture_output=True,
        )
        self.bundle_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
        self.source = self.verified / f"{self.bundle_hash}.rfupdate"
        shutil.copyfile(bundle, self.source)
        self.source.chmod(0o600)
        self.tampered = self.base / "tampered.rfupdate"
        with zipfile.ZipFile(bundle) as original, zipfile.ZipFile(self.tampered, "w") as modified:
            manifest = json.loads(original.read("manifest.json"))
            artifact_path = manifest["artifacts"][0]["path"]
            for member in original.infolist():
                contents = (
                    server_archive("unsigned-replacement")
                    if member.filename == artifact_path else original.read(member)
                )
                modified.writestr(member, contents)
        self.release_id = manifest["releaseId"]
        self.config = self.base / "runtime.conf"
        self.config.write_text("\n".join(
            f"{key}={shlex.quote(str(value))}" for key, value in {
                "ROOMFRAME_INSTALL_DIR": self.install,
                "ROOMFRAME_DATA_DIR": self.data,
                "ROOMFRAME_VERSION": "0.3.20",
                "ROOMFRAME_PRIMARY_HOST": "roomframe.example.test",
            }.items()
        ) + "\n")
        self.write_executable("compose", '''#!/usr/bin/env python3
import os, sys
if sys.argv[1:4] != ["exec", "-T", "postgres"]:
    raise SystemExit("unexpected compose operation")
if "SELECT version, status, sha256, signature_key_id" not in sys.stdin.read():
    raise SystemExit("unexpected SQL")
print("0.4.0\\tverified\\t" + os.environ["UPDATE_TEST_HASH"] + "\\ttest-snapshot")
''')
        self.write_executable("docker", '''#!/usr/bin/env python3
import os, pathlib, sys
if sys.argv[1:] in (["info"], ["compose", "version"]):
    raise SystemExit(0)
if sys.argv[1:4] != ["compose", "--env-file", "/dev/null"] or "build" not in sys.argv:
    raise SystemExit("unexpected docker operation")
candidate = pathlib.Path(sys.argv[sys.argv.index("-f") + 1]).parent
pathlib.Path(os.environ["UPDATE_TEST_BUILT"]).write_text((candidate / "build-label.txt").read_text())
raise SystemExit(71)  # Stop before backups, install, code swap or deployment.
''')
        self.write_executable("no-operation", "#!/bin/sh\nexit 98\n")
        self.verifier = self.base / "verify-and-mutate.py"
        self.verifier.write_text('''import json, os, pathlib, stat, subprocess, sys
subprocess.run([sys.executable, os.environ["UPDATE_TEST_REAL_VERIFIER"], *sys.argv[1:]], check=True)
bundle = pathlib.Path(sys.argv[1])
pathlib.Path(os.environ["UPDATE_TEST_VERIFIED"]).write_text(json.dumps({
    "path": str(bundle), "uid": bundle.stat().st_uid,
    "mode": stat.S_IMODE(bundle.stat().st_mode),
    "parent_mode": stat.S_IMODE(bundle.parent.stat().st_mode),
}))
source = pathlib.Path(os.environ["UPDATE_TEST_SOURCE"])
tampered = pathlib.Path(os.environ["UPDATE_TEST_TAMPERED"])
mode = os.environ["UPDATE_TEST_MUTATION"]
if mode == "in-place":
    source.write_bytes(tampered.read_bytes())
elif mode == "replace":
    os.replace(tampered, source)
''')

    def write_executable(self, name, text):
        target = self.bin / name
        target.write_text(text)
        target.chmod(0o755)

    def run_update(self, mutation="none"):
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "ROOMFRAME_RUNTIME_CONFIG": str(self.config),
            "ROOMFRAME_MAINTENANCE_LOCK_FILE": str(self.base / "maintenance.lock"),
            "ROOMFRAME_COMPOSE_COMMAND": str(self.bin / "compose"),
            "ROOMFRAME_BACKUP_COMMAND": str(self.bin / "no-operation"),
            "ROOMFRAME_VERIFY_BACKUP_COMMAND": str(self.bin / "no-operation"),
            "ROOMFRAME_VERIFY_UPDATE_COMMAND": str(self.verifier),
            "UPDATE_TEST_REAL_VERIFIER": str(ROOT / "scripts/verify-update-bundle.py"),
            "UPDATE_TEST_HASH": self.bundle_hash,
            "UPDATE_TEST_SOURCE": str(self.source),
            "UPDATE_TEST_TAMPERED": str(self.tampered),
            "UPDATE_TEST_MUTATION": mutation,
            "UPDATE_TEST_VERIFIED": str(self.base / "verified.json"),
            "UPDATE_TEST_BUILT": str(self.base / "built.txt"),
        }
        return subprocess.run(
            ["bash", ROOT / "scripts/roomframe-apply-update.sh",
             "--release-id", self.release_id, "--confirm", "0.4.0"],
            env=env, capture_output=True, text=True, timeout=20,
        )

    def assert_trusted_build(self, mutation):
        result = self.run_update(mutation)
        self.assertNotEqual(result.returncode, 0, "fake build must stop deployment")
        built = self.base / "built.txt"
        self.assertTrue(built.exists(), result.stdout + result.stderr)
        self.assertEqual(built.read_text(), "trusted")
        verification = json.loads((self.base / "verified.json").read_text())
        self.assertNotEqual(verification["path"], str(self.source))
        self.assertEqual(verification["uid"], 0)
        self.assertEqual(verification["mode"], 0o600)
        self.assertEqual(verification["parent_mode"], 0o700)
        if mutation != "none":
            self.assertNotEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.bundle_hash)
        self.assertFalse(list(self.base.glob(".roomframe-apply.*")), "staging must be removed")

    def test_valid_bundle_reaches_build(self):
        self.assert_trusted_build("none")

    def test_in_place_mutation_after_verification_is_not_used(self):
        self.assert_trusted_build("in-place")

    def test_atomic_replacement_after_verification_is_not_used(self):
        self.assert_trusted_build("replace")

    def test_tampering_before_verification_is_rejected(self):
        shutil.copyfile(self.tampered, self.source)
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / "built.txt").exists())
        self.assertFalse((self.base / "verified.json").exists())
        self.assertFalse(list(self.base.glob(".roomframe-apply.*")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
