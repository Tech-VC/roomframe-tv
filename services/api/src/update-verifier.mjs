import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import yauzl from 'yauzl';

const MANIFEST_LIMIT = 1024 * 1024;
const SIGNATURE_LIMIT = 4096;
const BUNDLE_UNCOMPRESSED_LIMIT = 8 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, archive) => {
    if (error) reject(Object.assign(new Error('invalid_update_zip'), { cause: error }));
    else resolve(archive);
  });
});

const safeEntryName = (name) => {
  if (
    typeof name !== 'string'
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
    || name.length > 512
    || path.posix.normalize(name) !== name
    || name.split('/').includes('..')
  ) {
    throw new Error('unsafe_update_path');
  }
  return name;
};

const isSymlink = (entry) => {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
};

const collectEntries = (archive) => new Promise((resolve, reject) => {
  const entries = new Map();
  let total = 0;
  archive.once('error', reject);
  archive.on('entry', (entry) => {
    try {
      const name = safeEntryName(entry.fileName);
      if (entries.has(name)) throw new Error('duplicate_update_entry');
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error('encrypted_update_entry');
      if (isSymlink(entry)) throw new Error('symlink_update_entry');
      total += entry.uncompressedSize;
      if (total > BUNDLE_UNCOMPRESSED_LIMIT) throw new Error('update_bundle_too_large');
      if (
        entry.uncompressedSize > 1024 * 1024
        && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
      ) {
        throw new Error('update_compression_ratio_exceeded');
      }
      entries.set(name, entry);
      archive.readEntry();
    } catch (error) {
      reject(error);
    }
  });
  archive.once('end', () => resolve(entries));
  archive.readEntry();
});

const openEntryStream = (archive, entry) => new Promise((resolve, reject) => {
  archive.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
});

const readEntryBuffer = async (archive, entry, limit) => {
  if (!entry || entry.uncompressedSize > limit) throw new Error('update_control_file_too_large');
  const chunks = [];
  let size = 0;
  const stream = await openEntryStream(archive, entry);
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('update_control_file_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const hashEntry = async (archive, entry) => {
  const digest = crypto.createHash('sha256');
  let size = 0;
  const stream = await openEntryStream(archive, entry);
  for await (const chunk of stream) {
    digest.update(chunk);
    size += chunk.length;
  }
  return { sha256: digest.digest('hex'), size };
};

const hashFile = async (file) => {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};

const decodeSignature = (value) => {
  if (value.length === 64) return value;
  const text = value.toString('ascii').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('invalid_update_signature_encoding');
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length !== 64) throw new Error('invalid_update_signature_length');
  return decoded;
};

const currentArchitecture = () => ({ x64: 'amd64', arm64: 'arm64' })[process.arch] ?? process.arch;

export const verifyUpdateBundle = async ({
  file,
  validators,
  trustDir,
  currentVersion,
}) => {
  const archive = await openZip(file);
  try {
    const entries = await collectEntries(archive);
    const manifestEntry = entries.get('manifest.json');
    const signatureEntry = entries.get('manifest.sig');
    if (!manifestEntry || !signatureEntry) throw new Error('update_bundle_incomplete');
    const manifestBytes = await readEntryBuffer(archive, manifestEntry, MANIFEST_LIMIT);
    const signatureBytes = decodeSignature(await readEntryBuffer(archive, signatureEntry, SIGNATURE_LIMIT));
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('invalid_update_manifest_json');
    }
    validators.assertUpdateBundle(manifest);

    const keyId = manifest.signature.keyId;
    const trustRoot = path.resolve(trustDir);
    const keyPath = path.resolve(trustRoot, `${keyId}.pem`);
    if (!keyPath.startsWith(`${trustRoot}${path.sep}`)) throw new Error('invalid_update_key_id');
    let publicKey;
    try {
      publicKey = await readFile(keyPath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error('untrusted_update_key'), { statusCode: 422 });
      throw error;
    }
    if (!crypto.verify(null, manifestBytes, publicKey, signatureBytes)) {
      throw Object.assign(new Error('invalid_update_signature'), { statusCode: 422 });
    }

    if (!semver.valid(manifest.version) || !semver.gt(manifest.version, currentVersion)) {
      throw Object.assign(new Error('update_version_not_newer'), { statusCode: 409 });
    }
    if (
      manifest.minimumServerVersion
      && !semver.gte(currentVersion, manifest.minimumServerVersion)
    ) {
      throw Object.assign(new Error('update_requires_newer_server'), { statusCode: 422 });
    }
    if (
      manifest.maximumServerVersion
      && !semver.lte(currentVersion, manifest.maximumServerVersion)
    ) {
      throw Object.assign(new Error('update_server_too_new'), { statusCode: 422 });
    }
    if (manifest.architectures && !manifest.architectures.includes(currentArchitecture())) {
      throw Object.assign(new Error('update_architecture_incompatible'), { statusCode: 422 });
    }

    const artifactPaths = new Set();
    for (const artifact of manifest.artifacts) {
      if (artifactPaths.has(artifact.path)) throw new Error('duplicate_update_artifact');
      artifactPaths.add(artifact.path);
      const entry = entries.get(artifact.path);
      if (!entry || artifact.path.endsWith('/')) throw new Error('missing_update_artifact');
      if (entry.uncompressedSize !== artifact.size) throw new Error('update_artifact_size_mismatch');
      const actual = await hashEntry(archive, entry);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
        throw Object.assign(new Error('update_artifact_hash_mismatch'), { statusCode: 422 });
      }
    }

    for (const [name] of entries) {
      if (name.endsWith('/')) continue;
      if (name === 'manifest.json' || name === 'manifest.sig') continue;
      if (!artifactPaths.has(name)) throw new Error('unlisted_update_artifact');
    }

    return {
      manifest,
      bundleSha256: await hashFile(file),
      signatureKeyId: keyId,
    };
  } finally {
    archive.close();
  }
};

export const quarantineVerifiedUpdate = async ({ source, releasesDir, bundleSha256 }) => {
  const quarantine = path.join(releasesDir, 'quarantine');
  const verified = path.join(releasesDir, 'verified');
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await mkdir(verified, { recursive: true, mode: 0o700 });
  const staged = path.join(
    quarantine,
    `${bundleSha256}.${crypto.randomUUID()}.rfupdate.part`,
  );
  const destination = path.join(verified, `${bundleSha256}.rfupdate`);
  try {
    await stat(destination);
    if (await hashFile(destination) === bundleSha256) {
      await unlink(source).catch(() => {});
      return destination;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await copyFile(source, staged);
    if (await hashFile(staged) !== bundleSha256) {
      throw new Error('quarantined_update_hash_mismatch');
    }
    await rename(staged, destination);
    await unlink(source).catch(() => {});
    return destination;
  } finally {
    await unlink(staged).catch(() => {});
  }
};
