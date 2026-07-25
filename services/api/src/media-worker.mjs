import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { withTransaction } from './database.mjs';
import { ensureStorageCapacity } from './media.mjs';

const MAX_JOB_ATTEMPTS = 3;
const MAX_SOURCE_PIXELS = 33_554_432;

const run = (command, args, {
  timeoutMs = 120_000,
  maxStdoutBytes = 1024 * 1024,
  maxStderrBytes = 64 * 1024,
} = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let forcedError = null;
  const timer = setTimeout(() => {
    forcedError = new Error(`${command}_timeout`);
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref();
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      forcedError = new Error(`${command}_stdout_limit`);
      child.kill('SIGKILL');
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxStderrBytes) stderr = stderr.subarray(stderr.length - maxStderrBytes);
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (forcedError) {
      reject(forcedError);
      return;
    }
    if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
    else reject(new Error(`${command}_failed:${stderr.toString('utf8').slice(-1000)}`));
  });
});

const describeFile = async (config, file, mime) => {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const information = await stat(file);
  return {
    path: path.relative(config.mediaDir, file),
    mime,
    sha256: digest.digest('hex'),
    size: information.size,
  };
};

const claimJob = (pool, workerId) => withTransaction(pool, async (client) => {
  const selected = await client.query(
    `SELECT * FROM media_jobs
     WHERE status = 'queued' AND available_at <= now()
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
  );
  const job = selected.rows[0];
  if (!job) return null;
  await client.query(
    `UPDATE media_jobs
     SET status = 'processing', attempts = attempts + 1, locked_at = now(),
         locked_by = $2, updated_at = now()
     WHERE id = $1`,
    [job.id, workerId],
  );
  await client.query(
    "UPDATE assets SET processing_status = 'processing' WHERE id = $1",
    [job.asset_id],
  );
  return { ...job, attempts: Number(job.attempts) + 1 };
});

export const recoverAbandonedMediaJobs = async (pool) => withTransaction(pool, async (client) => {
  const recovered = await client.query(
    `UPDATE media_jobs
     SET status = 'queued', available_at = now(), locked_at = NULL, locked_by = NULL,
         error_code = 'worker_restarted', updated_at = now()
     WHERE status = 'processing' AND attempts < $1
     RETURNING asset_id`,
    [MAX_JOB_ATTEMPTS],
  );
  if (recovered.rowCount > 0) {
    await client.query(
      `UPDATE assets
       SET processing_status = 'queued'
       WHERE id = ANY($1::uuid[])`,
      [recovered.rows.map((row) => row.asset_id)],
    );
  }
  const exhausted = await client.query(
    `UPDATE media_jobs
     SET status = 'failed', error_code = 'worker_attempts_exhausted', updated_at = now()
     WHERE status = 'processing' AND attempts >= $1
     RETURNING asset_id`,
    [MAX_JOB_ATTEMPTS],
  );
  if (exhausted.rowCount > 0) {
    await client.query(
      `UPDATE assets
       SET processing_status = 'failed',
           metadata = metadata || '{"errorCode":"worker_attempts_exhausted"}'::jsonb
       WHERE id = ANY($1::uuid[])`,
      [exhausted.rows.map((row) => row.asset_id)],
    );
  }
  return recovered.rowCount;
});

const processImage = async (job, config) => {
  const destination = path.join(config.mediaDir, 'objects', String(job.asset_id));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await ensureStorageCapacity(
    config.mediaDir,
    256 * 1024 * 1024,
    config.storageReserveBytes,
  );
  const source = sharp(job.input_path, { failOn: 'warning', limitInputPixels: 80_000_000 }).rotate();
  const metadata = await source.metadata();
  const thumbnail = path.join(destination, 'thumbnail.webp');
  const fullHd = path.join(destination, '1080p.webp');
  await source.clone().resize(480, 270, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 }).toFile(thumbnail);
  await source.clone().resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 }).toFile(fullHd);
  const variants = {
    thumbnail: await describeFile(config, thumbnail, 'image/webp'),
    '1080p': await describeFile(config, fullHd, 'image/webp'),
  };
  if ((metadata.width ?? 0) > 1920 || (metadata.height ?? 0) > 1080) {
    const ultraHd = path.join(destination, '4k.webp');
    await source.clone().resize(3840, 2160, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 }).toFile(ultraHd);
    variants['4k'] = await describeFile(config, ultraHd, 'image/webp');
  }
  return {
    variants,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    durationMs: null,
    metadata: { format: metadata.format, hasAlpha: Boolean(metadata.hasAlpha) },
  };
};

const probeVideo = async (input) => {
  const output = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration:format=duration',
    '-of', 'json',
    input,
  ]);
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0] ?? {};
  return {
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
    durationMs: Math.round(Number(stream.duration ?? parsed.format?.duration ?? 0) * 1000) || null,
  };
};

const transcode = (
  input,
  output,
  maxWidth,
  maxHeight,
  timeoutMs,
  maximumBitrate,
) => run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-map_metadata', '-1', '-map_chapters', '-1',
  '-vf', `scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
  '-maxrate', maximumBitrate, '-bufsize', `${Number.parseInt(maximumBitrate, 10) * 2}M`,
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  output,
], { timeoutMs });

const processVideo = async (job, config) => {
  const destination = path.join(config.mediaDir, 'objects', String(job.asset_id));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const metadata = await probeVideo(job.input_path);
  if (!metadata.width || !metadata.height || !metadata.durationMs) throw new Error('invalid_video_stream');
  if (
    metadata.width > 8192
    || metadata.height > 8192
    || metadata.width * metadata.height > MAX_SOURCE_PIXELS
  ) {
    throw new Error('video_dimensions_exceeded');
  }
  if (metadata.durationMs > config.maxVideoDurationSeconds * 1000) {
    throw new Error('video_duration_exceeded');
  }
  const durationSeconds = metadata.durationMs / 1000;
  const videoMegabitsPerSecond = 8
    + (metadata.width > 1920 || metadata.height > 1080 ? 25 : 0);
  const estimatedOutputBytes = Math.ceil(
    durationSeconds
    * (videoMegabitsPerSecond + 0.32)
    * 1_000_000
    / 8
    * 1.15,
  ) + 100 * 1024 * 1024;
  await ensureStorageCapacity(
    config.mediaDir,
    estimatedOutputBytes,
    config.storageReserveBytes,
  );
  const transcodeTimeout = Math.min(
    2 * 60 * 60 * 1000,
    Math.max(10 * 60 * 1000, metadata.durationMs * 4),
  );
  const thumbnail = path.join(destination, 'thumbnail.webp');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', '00:00:01', '-i', job.input_path,
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-frames:v', '1', '-vf', 'scale=480:270:force_original_aspect_ratio=decrease',
    thumbnail,
  ], { timeoutMs: 120_000 });
  const fullHd = path.join(destination, '1080p.mp4');
  await transcode(job.input_path, fullHd, 1920, 1080, transcodeTimeout, '8M');
  const variants = {
    thumbnail: await describeFile(config, thumbnail, 'image/webp'),
    '1080p': await describeFile(config, fullHd, 'video/mp4'),
  };
  if (metadata.width > 1920 || metadata.height > 1080) {
    const ultraHd = path.join(destination, '4k.mp4');
    await transcode(job.input_path, ultraHd, 3840, 2160, transcodeTimeout, '25M');
    variants['4k'] = await describeFile(config, ultraHd, 'video/mp4');
  }
  return { variants, ...metadata, metadata: { transcoded: true } };
};

export const processOneMediaJob = async (pool, config, workerId = `${os.hostname()}:${process.pid}`) => {
  const job = await claimJob(pool, workerId);
  if (!job) return false;
  try {
    const result = job.kind === 'image'
      ? await processImage(job, config)
      : await processVideo(job, config);
    await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE assets
         SET processing_status = 'ready', variants = $2, width = $3, height = $4,
             duration_ms = $5, metadata = $6
         WHERE id = $1`,
        [
          job.asset_id,
          JSON.stringify(result.variants),
          result.width,
          result.height,
          result.durationMs,
          JSON.stringify(result.metadata),
        ],
      );
      await client.query(
        "UPDATE media_jobs SET status = 'ready', updated_at = now() WHERE id = $1",
        [job.id],
      );
      await client.query(
        "UPDATE sync_state SET revision = revision + 1, updated_at = now() WHERE singleton = true",
      );
    });
  } catch (error) {
    const generated = path.resolve(config.mediaDir, 'objects', String(job.asset_id));
    const objectRoot = `${path.resolve(config.mediaDir, 'objects')}${path.sep}`;
    if (generated.startsWith(objectRoot)) {
      await rm(generated, { recursive: true, force: true }).catch(() => {});
    }
    const errorCode = String(error?.message ?? 'media_processing_failed').split(':')[0].slice(0, 120);
    const retry = Number(job.attempts) < MAX_JOB_ATTEMPTS;
    await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE assets
         SET processing_status = $2, metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [job.asset_id, retry ? 'queued' : 'failed', JSON.stringify({ errorCode })],
      );
      await client.query(
        `UPDATE media_jobs
         SET status = $2, error_code = $3,
             available_at = CASE
               WHEN $2 = 'queued' THEN now() + (attempts * interval '10 seconds')
               ELSE available_at
             END,
             locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id, retry ? 'queued' : 'failed', errorCode],
      );
    });
  }
  return true;
};
