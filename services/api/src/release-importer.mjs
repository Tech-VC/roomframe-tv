import { unlink } from 'node:fs/promises';
import { appendAudit } from './auth.mjs';
import { withTransaction } from './database.mjs';
import {
  materializeVerifiedApkArtifacts,
  quarantineVerifiedUpdate,
  verifyUpdateBundle,
} from './update-verifier.mjs';

const conflict = () => Object.assign(
  new Error('release_identity_conflict'),
  { statusCode: 409 },
);

const publicArtifact = ({ storagePath: _storagePath, ...artifact }) => artifact;

const releaseResult = (row, alreadyImported, fallbackArtifacts = []) => ({
  releaseId: row.id,
  version: row.version,
  status: row.status,
  signatureKeyId: row.signature_key_id,
  bundleSha256: row.sha256,
  storagePath: row.storage_path,
  apkArtifacts: (row.verification?.apkArtifacts ?? fallbackArtifacts).map(publicArtifact),
  alreadyImported,
});

export const importReleaseBundle = async ({
  pool,
  config,
  validators,
  source,
  actor = { actorType: 'system' },
  sourceDetails = { provider: 'manual' },
}) => {
  let verified;
  try {
    verified = await verifyUpdateBundle({
      file: source,
      validators,
      trustDir: config.updateTrustDir,
      currentVersion: config.version,
      allowNonNewer: true,
    });
  } catch (error) {
    await unlink(source).catch(() => {});
    throw error;
  }

  if (!verified.versionIsNewer) {
    const existing = await pool.query(
      `SELECT id, version, status, sha256, signature_key_id, verification, storage_path
       FROM release_history
       WHERE id = $1 AND version = $2 AND sha256 = $3`,
      [
        verified.manifest.releaseId,
        verified.manifest.version,
        verified.bundleSha256,
      ],
    );
    await unlink(source).catch(() => {});
    if (existing.rows.length === 1) {
      return releaseResult(existing.rows[0], true);
    }
    throw Object.assign(new Error('update_version_not_newer'), { statusCode: 409 });
  }

  const destination = await quarantineVerifiedUpdate({
    source,
    releasesDir: config.releasesDir,
    bundleSha256: verified.bundleSha256,
  });
  const apkArtifacts = await materializeVerifiedApkArtifacts({
    bundleFile: destination,
    manifest: verified.manifest,
    releasesDir: config.releasesDir,
  });
  const verification = {
    signature: 'valid',
    hashes: 'valid',
    compatibility: 'valid',
    dataPreservation: true,
    apkArtifacts,
    source: sourceDetails,
  };

  const result = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('roomframe-release-import'))");
    const existing = await client.query(
      `SELECT id, version, status, sha256, signature_key_id, verification, storage_path
       FROM release_history
       WHERE id = $1 OR version = $2 OR sha256 = $3
       FOR UPDATE`,
      [
        verified.manifest.releaseId,
        verified.manifest.version,
        verified.bundleSha256,
      ],
    );
    if (existing.rows.length > 0) {
      const same = existing.rows.find((row) => (
        row.id === verified.manifest.releaseId
        && row.version === verified.manifest.version
        && row.sha256 === verified.bundleSha256
      ));
      if (!same || existing.rows.length !== 1) throw conflict();
      return { row: same, alreadyImported: true };
    }

    const inserted = await client.query(
      `INSERT INTO release_history (
         id, version, manifest, status, sha256, signature_key_id,
         verification, storage_path, created_by
       ) VALUES ($1, $2, $3, 'verified', $4, $5, $6, $7, $8)
       RETURNING id, version, status, sha256, signature_key_id, verification, storage_path`,
      [
        verified.manifest.releaseId,
        verified.manifest.version,
        JSON.stringify(verified.manifest),
        verified.bundleSha256,
        verified.signatureKeyId,
        JSON.stringify(verification),
        destination,
        actor.session?.user_id ?? null,
      ],
    );
    await appendAudit(client, {
      session: actor.session ?? null,
      actorType: actor.actorType ?? 'system',
      action: 'release.imported',
      targetType: 'release',
      targetId: verified.manifest.releaseId,
      remoteAddress: actor.remoteAddress ?? null,
      details: {
        version: verified.manifest.version,
        sha256: verified.bundleSha256,
        source: sourceDetails.provider,
      },
    });
    return { row: inserted.rows[0], alreadyImported: false };
  });

  return releaseResult(result.row, result.alreadyImported, apkArtifacts);
};
