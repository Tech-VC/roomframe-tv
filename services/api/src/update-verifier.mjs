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

const invalidUpdate = (code, statusCode = 422, cause = undefined) => Object.assign(
  new Error(code),
  { statusCode, ...(cause ? { cause } : {}) },
);

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, archive) => {
    if (error) reject(invalidUpdate('invalid_update_zip', 422, error));
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
    throw invalidUpdate('unsafe_update_path');
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
      if (entries.has(name)) throw invalidUpdate('duplicate_update_entry');
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw invalidUpdate('encrypted_update_entry');
      if (isSymlink(entry)) throw invalidUpdate('symlink_update_entry');
      total += entry.uncompressedSize;
      if (total > BUNDLE_UNCOMPRESSED_LIMIT) throw invalidUpdate('update_bundle_too_large');
      if (
        entry.uncompressedSize > 1024 * 1024
        && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
      ) {
        throw invalidUpdate('update_compression_ratio_exceeded');
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
  if (!entry || entry.uncompressedSize > limit) throw invalidUpdate('update_control_file_too_large');
  const chunks = [];
  let size = 0;
  const stream = await openEntryStream(archive, entry);
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw invalidUpdate('update_control_file_too_large');
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
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw invalidUpdate('invalid_update_signature_encoding');
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length !== 64) throw invalidUpdate('invalid_update_signature_length');
  return decoded;
};

export const parseJsonWithUniqueKeys = (value) => {
  const source = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  let cursor = 0;

  const invalid = () => {
    throw invalidUpdate('invalid_update_manifest_json');
  };
  const skipWhitespace = () => {
    while (cursor < source.length && /[\t\n\r ]/.test(source[cursor])) cursor += 1;
  };
  const parseString = () => {
    if (source[cursor] !== '"') invalid();
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        cursor += 1;
        try {
          return JSON.parse(source.slice(start, cursor));
        } catch {
          invalid();
        }
      }
      cursor += 1;
    }
    invalid();
  };
  const parsePrimitive = () => {
    const start = cursor;
    while (
      cursor < source.length
      && !/[\t\n\r ,}\]]/.test(source[cursor])
    ) cursor += 1;
    if (cursor === start) invalid();
    try {
      JSON.parse(source.slice(start, cursor));
    } catch {
      invalid();
    }
  };
  const parseValue = (depth) => {
    if (depth > 64) invalid();
    skipWhitespace();
    if (source[cursor] === '{') {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        const key = parseString();
        if (keys.has(key)) throw invalidUpdate('duplicate_update_manifest_key');
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ':') invalid();
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ',') invalid();
        cursor += 1;
        skipWhitespace();
      }
      invalid();
    }
    if (source[cursor] === '[') {
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ',') invalid();
        cursor += 1;
        skipWhitespace();
      }
      invalid();
    }
    if (source[cursor] === '"') {
      parseString();
      return;
    }
    parsePrimitive();
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== source.length) invalid();
  try {
    return JSON.parse(source);
  } catch {
    invalid();
  }
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
    if (!manifestEntry || !signatureEntry) throw invalidUpdate('update_bundle_incomplete');
    const manifestBytes = await readEntryBuffer(archive, manifestEntry, MANIFEST_LIMIT);
    const signatureBytes = decodeSignature(await readEntryBuffer(archive, signatureEntry, SIGNATURE_LIMIT));
    const manifest = parseJsonWithUniqueKeys(manifestBytes);
    validators.assertUpdateBundle(manifest);

    const keyId = manifest.signature.keyId;
    const trustRoot = path.resolve(trustDir);
    const keyPath = path.resolve(trustRoot, `${keyId}.pem`);
    if (!keyPath.startsWith(`${trustRoot}${path.sep}`)) throw invalidUpdate('invalid_update_key_id');
    let publicKey;
    try {
      publicKey = await readFile(keyPath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw invalidUpdate('untrusted_update_key');
      throw error;
    }
    if (!crypto.verify(null, manifestBytes, publicKey, signatureBytes)) {
      throw invalidUpdate('invalid_update_signature');
    }

    if (!semver.valid(manifest.version) || !semver.gt(manifest.version, currentVersion)) {
      throw invalidUpdate('update_version_not_newer', 409);
    }
    if (
      manifest.minimumServerVersion
      && !semver.gte(currentVersion, manifest.minimumServerVersion)
    ) {
      throw invalidUpdate('update_requires_newer_server');
    }
    if (
      manifest.maximumServerVersion
      && !semver.lte(currentVersion, manifest.maximumServerVersion)
    ) {
      throw invalidUpdate('update_server_too_new');
    }
    if (manifest.architectures && !manifest.architectures.includes(currentArchitecture())) {
      throw invalidUpdate('update_architecture_incompatible');
    }

    const artifactPaths = new Set();
    for (const artifact of manifest.artifacts) {
      if (artifactPaths.has(artifact.path)) throw invalidUpdate('duplicate_update_artifact');
      artifactPaths.add(artifact.path);
      const entry = entries.get(artifact.path);
      if (!entry || artifact.path.endsWith('/')) throw invalidUpdate('missing_update_artifact');
      if (entry.uncompressedSize !== artifact.size) throw invalidUpdate('update_artifact_size_mismatch');
      const actual = await hashEntry(archive, entry);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
        throw invalidUpdate('update_artifact_hash_mismatch');
      }
    }

    for (const [name] of entries) {
      if (name.endsWith('/')) continue;
      if (name === 'manifest.json' || name === 'manifest.sig') continue;
      if (!artifactPaths.has(name)) throw invalidUpdate('unlisted_update_artifact');
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
