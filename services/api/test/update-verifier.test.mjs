import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestUpdate } from '../scripts/build-test-update.mjs';
import {
  materializeVerifiedApkArtifacts,
  quarantineVerifiedUpdate,
  verifyUpdateBundle,
} from '../src/update-verifier.mjs';
import { createValidators } from '../src/validation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const validators = await createValidators(path.join(root, 'contracts'));

test('un .rfupdate Ed25519 valide est accepté et les altérations sont refusées', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = await buildTestUpdate(path.join(directory, 'valid'));
  const verified = await verifyUpdateBundle({
    file: valid.bundlePath,
    validators,
    trustDir: path.dirname(valid.publicKeyPath),
    currentVersion: '0.3.0',
  });
  assert.equal(verified.manifest.version, '0.3.1');
  assert.equal(verified.signatureKeyId, 'dev-local');
  assert.match(verified.bundleSha256, /^[a-f0-9]{64}$/);

  const tampered = await buildTestUpdate(path.join(directory, 'tampered'), {
    tamperArtifact: true,
  });
  await assert.rejects(
    verifyUpdateBundle({
      file: tampered.bundlePath,
      validators,
      trustDir: path.dirname(tampered.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /update_artifact_size_mismatch|update_artifact_hash_mismatch/,
  );

  const otherKey = await buildTestUpdate(path.join(directory, 'other-key'));
  await assert.rejects(
    verifyUpdateBundle({
      file: otherKey.bundlePath,
      validators,
      trustDir: path.dirname(valid.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /invalid_update_signature/,
  );
});

test('un SBOM SPDX signé décrit exactement la source et l’archive serveur', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-sbom-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = await buildTestUpdate(path.join(directory, 'valid'), {
    includeSupplyChain: true,
    serverArtifactKind: 'server-archive',
  });
  const verified = await verifyUpdateBundle({
    file: valid.bundlePath,
    validators,
    trustDir: path.dirname(valid.publicKeyPath),
    currentVersion: '0.3.0',
  });
  assert.equal(verified.manifest.source.repository, 'example/roomframe');
  assert.equal(
    verified.manifest.artifacts.filter((artifact) => artifact.kind === 'sbom-spdx').length,
    1,
  );

  const invalid = await buildTestUpdate(path.join(directory, 'invalid'), {
    includeSupplyChain: true,
    invalidSbom: true,
    serverArtifactKind: 'server-archive',
  });
  await assert.rejects(
    verifyUpdateBundle({
      file: invalid.bundlePath,
      validators,
      trustDir: path.dirname(invalid.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /invalid_update_sbom/,
  );
});

test('la quarantaine remplace une copie corrompue ou un lien symbolique', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-update-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = await buildTestUpdate(path.join(directory, 'source'));
  const verified = await verifyUpdateBundle({
    file: valid.bundlePath,
    validators,
    trustDir: path.dirname(valid.publicKeyPath),
    currentVersion: '0.3.0',
  });
  const releasesDir = path.join(directory, 'releases');
  const destination = path.join(
    releasesDir,
    'verified',
    `${verified.bundleSha256}.rfupdate`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  const external = path.join(directory, 'outside.rfupdate');
  await writeFile(external, 'corrompu');
  await symlink(external, destination);
  const quarantined = await quarantineVerifiedUpdate({
    source: valid.bundlePath,
    releasesDir,
    bundleSha256: verified.bundleSha256,
  });
  assert.equal(quarantined, destination);
  const digest = crypto.createHash('sha256').update(await readFile(destination)).digest('hex');
  assert.equal(digest, verified.bundleSha256);
  assert.equal(await readFile(external, 'utf8'), 'corrompu');
});

test('un APK signé par le bundle est matérialisé par hash hors du ZIP', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-update-apk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = await buildTestUpdate(path.join(directory, 'source'), {
    includeHomeApk: true,
  });
  const verified = await verifyUpdateBundle({
    file: valid.bundlePath,
    validators,
    trustDir: path.dirname(valid.publicKeyPath),
    currentVersion: '0.3.0',
  });
  const releasesDir = path.join(directory, 'releases');
  const bundleFile = await quarantineVerifiedUpdate({
    source: valid.bundlePath,
    releasesDir,
    bundleSha256: verified.bundleSha256,
  });
  const artifacts = await materializeVerifiedApkArtifacts({
    bundleFile,
    manifest: verified.manifest,
    releasesDir,
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].packageName, 'org.roomframe.tv');
  assert.match(artifacts[0].storagePath, /artifacts[/\\][0-9a-f-]+[/\\][a-f0-9]{64}\.apk$/);
  const bytes = await readFile(artifacts[0].storagePath);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), artifacts[0].sha256);
});

test('un artefact non listé et un downgrade sont refusés', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-update-negative-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extra = await buildTestUpdate(path.join(directory, 'extra'), {
    extraEntries: [{ path: 'server/unlisted.txt', content: 'not listed' }],
  });
  await assert.rejects(
    verifyUpdateBundle({
      file: extra.bundlePath,
      validators,
      trustDir: path.dirname(extra.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /unlisted_update_artifact/,
  );

  const downgrade = await buildTestUpdate(path.join(directory, 'downgrade'), {
    version: '0.2.9',
  });
  await assert.rejects(
    verifyUpdateBundle({
      file: downgrade.bundlePath,
      validators,
      trustDir: path.dirname(downgrade.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /update_version_not_newer/,
  );

  const duplicateKey = await buildTestUpdate(path.join(directory, 'duplicate-key'), {
    manifestTextTransform: (manifest) => manifest.replace(
      '"formatVersion": 1,',
      '"formatVersion": 1,\n  "formatVersion": 1,',
    ),
  });
  await assert.rejects(
    verifyUpdateBundle({
      file: duplicateKey.bundlePath,
      validators,
      trustDir: path.dirname(duplicateKey.publicKeyPath),
      currentVersion: '0.3.0',
    }),
    /duplicate_update_manifest_key/,
  );
});
