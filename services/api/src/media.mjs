import crypto from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  rename,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';

const allowedTypes = new Map([
  ['image/jpeg', {
    kind: 'image',
    extension: '.jpg',
    suppliedExtensions: new Set(['.jpg', '.jpeg']),
  }],
  ['image/png', {
    kind: 'image',
    extension: '.png',
    suppliedExtensions: new Set(['.png']),
  }],
  ['image/webp', {
    kind: 'image',
    extension: '.webp',
    suppliedExtensions: new Set(['.webp']),
  }],
  ['image/avif', {
    kind: 'image',
    extension: '.avif',
    suppliedExtensions: new Set(['.avif']),
  }],
  ['video/mp4', {
    kind: 'video',
    extension: '.mp4',
    suppliedExtensions: new Set(['.mp4', '.m4v']),
  }],
  ['video/webm', {
    kind: 'video',
    extension: '.webm',
    suppliedExtensions: new Set(['.webm']),
  }],
  ['video/quicktime', {
    kind: 'video',
    extension: '.mov',
    suppliedExtensions: new Set(['.mov']),
  }],
]);

const safeOriginalName = (value) => path.basename(String(value ?? 'media'))
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .slice(0, 180);

export const ensureStorageCapacity = async (
  directory,
  expectedBytes,
  reserveBytes,
) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filesystem = await statfs(directory, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const required = BigInt(Math.max(0, expectedBytes)) + BigInt(reserveBytes);
  if (available < required) {
    throw Object.assign(new Error('insufficient_storage'), { statusCode: 507 });
  }
};

const writeUpload = async (stream, target, maxBytes) => {
  let byteSize = 0;
  const digest = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        callback(Object.assign(new Error('media_too_large'), { statusCode: 413 }));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(stream, meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return { byteSize, sha256: digest.digest('hex') };
};

const detectMedia = async (file, originalName) => {
  const type = await fileTypeFromFile(file);
  if (!type || !allowedTypes.has(type.mime)) {
    throw Object.assign(new Error('unsupported_media_type'), { statusCode: 415 });
  }
  const descriptor = allowedTypes.get(type.mime);
  const suppliedExtension = path.extname(originalName).toLowerCase();
  if (!descriptor.suppliedExtensions.has(suppliedExtension)) {
    throw Object.assign(new Error('media_extension_mismatch'), { statusCode: 415 });
  }
  return {
    kind: descriptor.kind,
    extension: descriptor.extension,
    mime: type.mime,
  };
};

export const storeMediaUpload = async ({
  part,
  config,
  pool,
  userId,
  declaredBytes = null,
}) => {
  await mkdir(config.processingDir, { recursive: true, mode: 0o700 });
  await ensureStorageCapacity(
    config.processingDir,
    Number.isSafeInteger(declaredBytes) && declaredBytes > 0
      ? Math.min(declaredBytes, config.maxVideoBytes)
      : config.maxVideoBytes,
    config.storageReserveBytes,
  );
  const temporary = path.join(config.processingDir, `upload-${crypto.randomUUID()}.part`);
  const originalName = safeOriginalName(part.filename);
  try {
    const written = await writeUpload(part.file, temporary, config.maxVideoBytes);
    const detected = await detectMedia(temporary, originalName);
    const maximum = detected.kind === 'image' ? config.maxImageBytes : config.maxVideoBytes;
    if (written.byteSize > maximum) {
      throw Object.assign(new Error('media_too_large'), { statusCode: 413 });
    }

    const directory = path.join(config.mediaDir, 'originals', written.sha256.slice(0, 2));
    const finalPath = path.join(directory, `${written.sha256}${detected.extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await stat(finalPath);
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // processing/ et media/ sont des montages Docker distincts : rename(2)
      // peut retourner EXDEV. La copie se fait donc vers un staging situé
      // dans le répertoire final, puis seul le dernier renommage est atomique.
      const staged = path.join(
        directory,
        `.${written.sha256}.${crypto.randomUUID()}.part`,
      );
      try {
        await copyFile(temporary, staged, constants.COPYFILE_EXCL);
        await rename(staged, finalPath);
        await unlink(temporary);
      } catch (copyError) {
        await unlink(staged).catch(() => {});
        throw copyError;
      }
    }

    const relativePath = path.relative(config.mediaDir, finalPath);
    const result = await pool.query(
      `INSERT INTO assets (
         id, sha256, media_type, original_media_type, storage_path, original_filename,
         byte_size, processing_status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)
       ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
       RETURNING *`,
      [
        crypto.randomUUID(),
        written.sha256,
        detected.kind,
        detected.mime,
        relativePath,
        originalName,
        written.byteSize,
        userId,
      ],
    );
    const asset = result.rows[0];
    if (asset.processing_status === 'queued') {
      await pool.query(
        `INSERT INTO media_jobs (id, asset_id, kind, input_path)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (asset_id) WHERE status IN ('queued', 'processing')
         DO NOTHING`,
        [crypto.randomUUID(), asset.id, detected.kind, finalPath],
      );
    }
    return asset;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

export const mediaVariantPath = async (config, asset, variant) => {
  const allowed = ['thumbnail', '1080p', '4k'];
  if (!allowed.includes(variant)) return null;
  const record = asset.variants?.[variant];
  if (!record?.path) return null;
  const resolved = path.resolve(config.mediaDir, record.path);
  const root = `${path.resolve(config.mediaDir)}${path.sep}`;
  if (!resolved.startsWith(root)) return null;
  await stat(resolved);
  return resolved;
};

export const streamMediaVariant = (reply, file, mime) => {
  reply.header('content-type', mime);
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(createReadStream(file));
};
