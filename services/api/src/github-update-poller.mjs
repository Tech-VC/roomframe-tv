import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureStorageCapacity } from './media.mjs';
import { importReleaseBundle } from './release-importer.mjs';
import { releaseSourceKey } from './update-source.mjs';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const METADATA_LIMIT = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;

const controlledError = (code, statusCode = undefined, cause = undefined) => Object.assign(
  new Error(code),
  {
    ...(statusCode ? { statusCode } : {}),
    ...(cause ? { cause } : {}),
  },
);

const safeErrorCode = (error) => {
  const candidate = String(error?.message ?? 'github_update_poll_failed');
  return /^[a-z0-9][a-z0-9:_-]{0,119}$/.test(candidate)
    ? candidate
    : 'github_update_poll_failed';
};

const isAllowedRedirect = (url) => (
  url.protocol === 'https:'
  && url.port === ''
  && url.username === ''
  && url.password === ''
  && (
    url.hostname === 'api.github.com'
    || url.hostname === 'github.com'
    || url.hostname.endsWith('.githubusercontent.com')
  )
);

const fetchWithRedirects = async ({
  url,
  headers,
  fetchImpl,
  timeoutMs,
  allowRedirect,
}) => {
  let current = new URL(url);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw controlledError(
        error?.name === 'TimeoutError' ? 'github_request_timeout' : 'github_request_failed',
        502,
        error,
      );
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => {});
      throw controlledError('github_redirect_limit_exceeded', 502);
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw controlledError('github_redirect_without_location', 502);
    const next = new URL(location, current);
    if (!allowRedirect(next)) throw controlledError('github_redirect_not_allowed', 502);
    current = next;
  }
  throw controlledError('github_redirect_limit_exceeded', 502);
};

const readLimitedJson = async (response) => {
  if (!response.body) throw controlledError('github_empty_response', 502);
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > METADATA_LIMIT) throw controlledError('github_metadata_too_large', 502);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw controlledError('invalid_github_release_response', 502, error);
  }
};

const safeInteger = (value, code) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw controlledError(code, 502);
  return number;
};

const exactAssetApiUrl = (value, repository, assetId) => {
  const candidate = new URL(String(value ?? ''));
  const expectedPath = `/repos/${repository}/releases/assets/${assetId}`.toLowerCase();
  if (
    candidate.origin !== API_ORIGIN
    || candidate.pathname.toLowerCase() !== expectedPath
    || candidate.search !== ''
    || candidate.hash !== ''
    || candidate.username !== ''
    || candidate.password !== ''
  ) {
    throw controlledError('invalid_github_asset_url', 502);
  }
  return candidate.toString();
};

const parseCandidate = (release, repository, maximumBytes) => {
  const releaseId = safeInteger(release?.id, 'invalid_github_release_id');
  const assets = Array.isArray(release?.assets)
    ? release.assets.filter((asset) => (
      asset?.state === 'uploaded'
      && typeof asset?.name === 'string'
      && asset.name.toLowerCase().endsWith('.rfupdate')
    ))
    : [];
  if (assets.length === 0) return null;
  const tagName = String(release?.tag_name ?? '');
  if (
    tagName.length > 160
    || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(tagName)
  ) {
    throw controlledError('invalid_github_release_tag', 422);
  }
  if (assets.length !== 1) throw controlledError('ambiguous_rfupdate_assets', 422);
  const asset = assets[0];
  const assetId = safeInteger(asset.id, 'invalid_github_asset_id');
  const size = safeInteger(asset.size, 'invalid_github_asset_size');
  if (size > maximumBytes) throw controlledError('github_update_too_large', 413);
  if (
    asset.name.length > 200
    || path.basename(asset.name) !== asset.name
    || /[\u0000-\u001f\u007f]/.test(asset.name)
  ) {
    throw controlledError('invalid_github_asset_name', 422);
  }
  const digest = asset.digest == null ? null : String(asset.digest).toLowerCase();
  if (digest !== null && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw controlledError('invalid_github_asset_digest', 422);
  }
  const updatedAt = new Date(asset.updated_at);
  if (Number.isNaN(updatedAt.getTime())) {
    throw controlledError('invalid_github_asset_timestamp', 502);
  }
  return {
    release: {
      id: releaseId,
      tagName,
      prerelease: Boolean(release.prerelease),
      publishedAt: release.published_at ?? null,
    },
    asset: {
      id: assetId,
      name: asset.name,
      size,
      digest: digest?.slice('sha256:'.length) ?? null,
      updatedAt: updatedAt.toISOString(),
      apiUrl: exactAssetApiUrl(asset.url, repository, assetId),
    },
  };
};

export const discoverGithubUpdate = async ({
  repository,
  channel,
  etag = null,
  maximumBytes,
  version,
  timeoutMs,
  fetchImpl = fetch,
}) => {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `RoomFrame/${version}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetchWithRedirects({
    url: `${API_ORIGIN}/repos/${repository}/releases?per_page=20`,
    headers,
    fetchImpl,
    timeoutMs,
    allowRedirect: (url) => url.origin === API_ORIGIN,
  });
  const responseEtag = response.headers.get('etag')?.slice(0, 512) ?? etag;
  if (response.status === 304) {
    await response.body?.cancel().catch(() => {});
    return { status: 'not-modified', etag: responseEtag, candidate: null };
  }
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw controlledError('github_rate_limited', 503);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw controlledError('github_releases_request_failed', 502);
  }
  const releases = await readLimitedJson(response);
  if (!Array.isArray(releases)) throw controlledError('invalid_github_release_response', 502);
  for (const release of releases) {
    if (release?.draft === true) continue;
    if (channel === 'stable' && release?.prerelease === true) continue;
    const candidate = parseCandidate(release, repository, maximumBytes);
    if (candidate) return { status: 'candidate', etag: responseEtag, candidate };
  }
  return { status: 'no-candidate', etag: responseEtag, candidate: null };
};

export const downloadGithubUpdate = async ({
  candidate,
  repository,
  processingDir,
  maximumBytes,
  reserveBytes,
  version,
  timeoutMs,
  fetchImpl = fetch,
}) => {
  await ensureStorageCapacity(processingDir, candidate.asset.size, reserveBytes);
  await mkdir(processingDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    processingDir,
    `github-release-${crypto.randomUUID()}.rfupdate.part`,
  );
  const headers = {
    Accept: 'application/octet-stream',
    'Accept-Encoding': 'identity',
    'User-Agent': `RoomFrame/${version}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
  try {
    const response = await fetchWithRedirects({
      url: exactAssetApiUrl(candidate.asset.apiUrl, repository, candidate.asset.id),
      headers,
      fetchImpl,
      timeoutMs,
      allowRedirect: isAllowedRedirect,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw controlledError('github_asset_download_failed', 502);
    }
    const announced = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(announced)
      && announced > 0
      && (announced !== candidate.asset.size || announced > maximumBytes)
    ) {
      await response.body.cancel().catch(() => {});
      throw controlledError('github_asset_size_mismatch', 422);
    }
    const digest = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maximumBytes || size > candidate.asset.size) {
          callback(controlledError('github_update_too_large', 413));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const sha256 = digest.digest('hex');
    if (size !== candidate.asset.size) throw controlledError('github_asset_size_mismatch', 422);
    if (candidate.asset.digest && sha256 !== candidate.asset.digest) {
      throw controlledError('github_asset_digest_mismatch', 422);
    }
    return { file: temporary, size, sha256 };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

const readPollState = async (pool, sourceKey) => {
  const result = await pool.query(
    'SELECT * FROM update_poll_state WHERE source_key = $1',
    [sourceKey],
  );
  return result.rows[0] ?? null;
};

const recordPollState = async ({
  pool,
  sourceKey,
  repository,
  channel,
  etag,
  result,
  errorCode = null,
  candidate = null,
  importedReleaseId = null,
}) => {
  const successful = ['not-modified', 'no-candidate', 'already-imported', 'imported']
    .includes(result);
  await pool.query(
    `INSERT INTO update_poll_state (
       source_key, provider, repository, channel, etag, last_checked_at,
       last_success_at, last_result, last_error_code, external_release_id,
       external_asset_id, external_asset_updated_at, imported_release_id, updated_at
     ) VALUES (
       $1, 'github', $2, $3, $4, now(),
       CASE WHEN $5 THEN now() ELSE NULL END, $6, $7, $8, $9, $10, $11, now()
     )
     ON CONFLICT (source_key) DO UPDATE SET
       repository = EXCLUDED.repository,
       channel = EXCLUDED.channel,
       etag = COALESCE(EXCLUDED.etag, update_poll_state.etag),
       last_checked_at = EXCLUDED.last_checked_at,
       last_success_at = CASE
         WHEN $5 THEN now()
         ELSE update_poll_state.last_success_at
       END,
       last_result = EXCLUDED.last_result,
       last_error_code = EXCLUDED.last_error_code,
       external_release_id = COALESCE(
         EXCLUDED.external_release_id,
         update_poll_state.external_release_id
       ),
       external_asset_id = COALESCE(
         EXCLUDED.external_asset_id,
         update_poll_state.external_asset_id
       ),
       external_asset_updated_at = COALESCE(
         EXCLUDED.external_asset_updated_at,
         update_poll_state.external_asset_updated_at
       ),
       imported_release_id = COALESCE(
         EXCLUDED.imported_release_id,
         update_poll_state.imported_release_id
       ),
       updated_at = now()`,
    [
      sourceKey,
      repository,
      channel,
      etag,
      successful,
      result,
      errorCode,
      candidate?.release.id ?? null,
      candidate?.asset.id ?? null,
      candidate?.asset.updatedAt ?? null,
      importedReleaseId,
    ],
  );
};

export const pollGithubUpdates = async ({
  pool,
  config,
  validators,
  fetchImpl = fetch,
}) => {
  const repository = config.updateGithubRepository;
  if (!repository) return { status: 'disabled' };
  const channel = config.updateGithubChannel;
  const sourceKey = releaseSourceKey(repository, channel);
  const previous = await readPollState(pool, sourceKey);
  let discovery = null;
  try {
    discovery = await discoverGithubUpdate({
      repository,
      channel,
      etag: previous?.etag ?? null,
      maximumBytes: config.maxUpdateBytes,
      version: config.version,
      timeoutMs: config.updateRequestTimeoutMs,
      fetchImpl,
    });
    if (discovery.status !== 'candidate') {
      await recordPollState({
        pool,
        sourceKey,
        repository,
        channel,
        etag: discovery.etag,
        result: discovery.status,
      });
      return { status: discovery.status };
    }
    const candidate = discovery.candidate;
    if (
      previous?.imported_release_id
      && Number(previous.external_asset_id) === candidate.asset.id
      && new Date(previous.external_asset_updated_at).toISOString() === candidate.asset.updatedAt
    ) {
      await recordPollState({
        pool,
        sourceKey,
        repository,
        channel,
        etag: discovery.etag,
        result: 'already-imported',
        candidate,
        importedReleaseId: previous.imported_release_id,
      });
      return {
        status: 'already-imported',
        releaseId: previous.imported_release_id,
      };
    }
    const downloaded = await downloadGithubUpdate({
      candidate,
      repository,
      processingDir: config.processingDir,
      maximumBytes: config.maxUpdateBytes,
      reserveBytes: config.storageReserveBytes,
      version: config.version,
      timeoutMs: config.updateRequestTimeoutMs,
      fetchImpl,
    });
    const imported = await importReleaseBundle({
      pool,
      config,
      validators,
      source: downloaded.file,
      actor: { actorType: 'system' },
      sourceDetails: {
        provider: 'github',
        repository,
        channel,
        tagName: candidate.release.tagName,
        releaseId: candidate.release.id,
        assetId: candidate.asset.id,
        assetName: candidate.asset.name,
        publishedAt: candidate.release.publishedAt,
      },
    });
    const status = imported.alreadyImported ? 'already-imported' : 'imported';
    await recordPollState({
      pool,
      sourceKey,
      repository,
      channel,
      etag: discovery.etag,
      result: status,
      candidate,
      importedReleaseId: imported.releaseId,
    });
    return { status, releaseId: imported.releaseId, version: imported.version };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    const result = [409, 413, 422].includes(error?.statusCode) ? 'rejected' : 'error';
    await recordPollState({
      pool,
      sourceKey,
      repository,
      channel,
      etag: discovery?.etag ?? previous?.etag ?? null,
      result,
      errorCode,
      candidate: discovery?.candidate ?? null,
    }).catch(() => {});
    throw error;
  }
};
