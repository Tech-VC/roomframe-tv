import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeGithubRepository,
  normalizeUpdateChannel,
} from './update-source.mjs';

const readTextFile = async (file, label) => {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (!value) throw new Error(`${label}_empty`);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label}_missing`);
    throw error;
  }
};

const positiveInteger = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
};

export const loadConfig = async (overrides = {}) => {
  const requireAuthSecrets = overrides.requireAuthSecrets !== false;
  const secretRoot = overrides.secretRoot ?? process.env.ROOMFRAME_SECRET_DIR ?? '/run/secrets';
  const dataRoot = overrides.dataRoot ?? process.env.ROOMFRAME_DATA_DIR ?? '/data';
  const passwordFile = overrides.postgresPasswordFile
    ?? process.env.ROOMFRAME_POSTGRES_PASSWORD_FILE
    ?? path.join(secretRoot, 'postgres_password');
  const bootstrapTokenFile = overrides.bootstrapTokenFile
    ?? process.env.ROOMFRAME_BOOTSTRAP_TOKEN_FILE
    ?? path.join(secretRoot, 'bootstrap_token');
  const sessionSecretFile = overrides.sessionSecretFile
    ?? process.env.ROOMFRAME_SESSION_SECRET_FILE
    ?? path.join(secretRoot, 'session_secret');
  const totpKeyFile = overrides.totpKeyFile
    ?? process.env.ROOMFRAME_TOTP_KEY_FILE
    ?? path.join(secretRoot, 'totp_encryption_key');

  const postgresPassword = overrides.postgresPassword
    ?? await readTextFile(passwordFile, 'postgres_password');
  const [bootstrapToken, sessionSecret, totpEncryptionKey] = requireAuthSecrets
    ? await Promise.all([
      overrides.bootstrapToken ?? readTextFile(bootstrapTokenFile, 'bootstrap_token'),
      overrides.sessionSecret ?? readTextFile(sessionSecretFile, 'session_secret'),
      overrides.totpEncryptionKey ?? readTextFile(totpKeyFile, 'totp_encryption_key'),
    ])
    : [null, null, null];

  return Object.freeze({
    port: positiveInteger(overrides.port ?? process.env.PORT, 8080),
    version: overrides.version ?? process.env.ROOMFRAME_VERSION ?? '0.3.0',
    publicUrl: overrides.publicUrl ?? process.env.ROOMFRAME_PUBLIC_URL ?? null,
    preferredUrl: overrides.preferredUrl ?? process.env.ROOMFRAME_PREFERRED_URL ?? null,
    fallbackUrl: overrides.fallbackUrl ?? process.env.ROOMFRAME_FALLBACK_URL ?? null,
    apiUrl: overrides.apiUrl ?? process.env.ROOMFRAME_API_URL ?? null,
    serverIp: overrides.serverIp ?? process.env.ROOMFRAME_SERVER_IP ?? null,
    primaryHost: overrides.primaryHost ?? process.env.ROOMFRAME_PRIMARY_HOST ?? null,
    serverStateFile: overrides.serverStateFile
      ?? process.env.ROOMFRAME_SERVER_STATE_FILE
      ?? '/run/roomframe/server-state.json',
    defaultBundleDir: overrides.defaultBundleDir
      ?? process.env.ROOMFRAME_DEFAULT_BUNDLE_DIR
      ?? '/defaults/experience',
    contractsDir: overrides.contractsDir ?? process.env.ROOMFRAME_CONTRACTS_DIR ?? '/app/contracts',
    migrationsDir: overrides.migrationsDir
      ?? process.env.ROOMFRAME_MIGRATIONS_DIR
      ?? '/app/database/migrations',
    mediaDir: overrides.mediaDir ?? process.env.ROOMFRAME_MEDIA_DIR ?? path.join(dataRoot, 'media'),
    processingDir: overrides.processingDir
      ?? process.env.ROOMFRAME_PROCESSING_DIR
      ?? path.join(dataRoot, 'processing'),
    releasesDir: overrides.releasesDir
      ?? process.env.ROOMFRAME_RELEASES_DIR
      ?? path.join(dataRoot, 'releases'),
    backupsDir: overrides.backupsDir
      ?? process.env.ROOMFRAME_BACKUPS_DIR
      ?? path.join(dataRoot, 'backups'),
    recoveryRequestFile: overrides.recoveryRequestFile
      ?? process.env.ROOMFRAME_RECOVERY_REQUEST_FILE
      ?? path.join(dataRoot, 'app', 'recovery', 'request.json'),
    updateTrustDir: overrides.updateTrustDir
      ?? process.env.ROOMFRAME_UPDATE_TRUST_DIR
      ?? '/run/roomframe/update-trust',
    updateGithubRepository: normalizeGithubRepository(
      overrides.updateGithubRepository
      ?? process.env.ROOMFRAME_UPDATE_GITHUB_REPOSITORY,
    ),
    updateGithubChannel: normalizeUpdateChannel(
      overrides.updateGithubChannel
      ?? process.env.ROOMFRAME_UPDATE_GITHUB_CHANNEL,
    ),
    updatePollMinutes: boundedInteger(
      overrides.updatePollMinutes ?? process.env.ROOMFRAME_UPDATE_POLL_MINUTES,
      360,
      15,
      10_080,
    ),
    updateRequestTimeoutMs: boundedInteger(
      overrides.updateRequestTimeoutMs
      ?? process.env.ROOMFRAME_UPDATE_REQUEST_TIMEOUT_MS,
      60_000,
      5_000,
      300_000,
    ),
    maxImageBytes: positiveInteger(
      overrides.maxImageBytes ?? process.env.ROOMFRAME_MAX_IMAGE_BYTES,
      25 * 1024 * 1024,
    ),
    maxVideoBytes: positiveInteger(
      overrides.maxVideoBytes ?? process.env.ROOMFRAME_MAX_VIDEO_BYTES,
      2 * 1024 * 1024 * 1024,
    ),
    maxVideoDurationSeconds: positiveInteger(
      overrides.maxVideoDurationSeconds ?? process.env.ROOMFRAME_MAX_VIDEO_DURATION_SECONDS,
      30 * 60,
    ),
    maxUpdateBytes: positiveInteger(
      overrides.maxUpdateBytes ?? process.env.ROOMFRAME_MAX_UPDATE_BYTES,
      4 * 1024 * 1024 * 1024,
    ),
    storageReserveBytes: positiveInteger(
      overrides.storageReserveBytes ?? process.env.ROOMFRAME_STORAGE_RESERVE_BYTES,
      512 * 1024 * 1024,
    ),
    telemetryRetentionDays: positiveInteger(
      overrides.telemetryRetentionDays ?? process.env.ROOMFRAME_TELEMETRY_RETENTION_DAYS,
      90,
    ),
    sessionHours: positiveInteger(
      overrides.sessionHours ?? process.env.ROOMFRAME_SESSION_HOURS,
      12,
    ),
    database: {
      host: overrides.dbHost ?? process.env.ROOMFRAME_DB_HOST ?? 'postgres',
      port: positiveInteger(overrides.dbPort ?? process.env.ROOMFRAME_DB_PORT, 5432),
      database: overrides.dbName ?? process.env.ROOMFRAME_DB_NAME ?? 'roomframe',
      user: overrides.dbUser ?? process.env.ROOMFRAME_DB_USER ?? 'roomframe',
      password: postgresPassword,
      max: positiveInteger(overrides.dbPoolSize ?? process.env.ROOMFRAME_DB_POOL_SIZE, 10),
      application_name: overrides.applicationName ?? 'roomframe-api',
    },
    bootstrapToken,
    sessionSecret,
    totpEncryptionKey,
  });
};
