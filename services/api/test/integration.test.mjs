import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createPool, runMigrations } from '../src/database.mjs';
import { csrfTokenForSession, keyedDigest } from '../src/security.mjs';
import { totpAtCounter } from '../src/totp.mjs';

const databaseHost = process.env.ROOMFRAME_TEST_DB_HOST;
const root = fileURLToPath(new URL('../../../', import.meta.url));

const token = () => crypto.randomBytes(32).toString('base64url');
const totpNow = (secret, offset = 0) => totpAtCounter(
  secret,
  Math.floor(Date.now() / 1000 / 30) + offset,
);

const cookieHeader = (response) => {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';')[0] ?? '';
};

test('bootstrap concurrent, auth, mise à jour personnalisée et cache TV restent cohérents', {
  skip: !databaseHost,
  timeout: 120_000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'roomframe-integration-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bootstrapToken = token();
  const config = await loadConfig({
    port: 0,
    version: '0.3.0',
    publicUrl: 'https://roomframe.test',
    preferredUrl: 'https://roomframe.test',
    fallbackUrl: 'https://192.0.2.20',
    apiUrl: 'https://roomframe.test/api',
    serverIp: '192.0.2.20',
    primaryHost: 'roomframe.test',
    serverStateFile: path.join(temporary, 'missing-server-state.json'),
    defaultBundleDir: path.join(root, 'defaults/experience'),
    contractsDir: path.join(root, 'contracts'),
    migrationsDir: path.join(root, 'database/migrations'),
    mediaDir: path.join(temporary, 'media'),
    processingDir: path.join(temporary, 'processing'),
    releasesDir: path.join(temporary, 'releases'),
    backupsDir: path.join(temporary, 'backups'),
    updateTrustDir: path.join(temporary, 'trust'),
    recoveryRequestFile: path.join(temporary, 'recovery/request.json'),
    dbHost: databaseHost,
    dbPort: Number(process.env.ROOMFRAME_TEST_DB_PORT ?? 5432),
    dbName: process.env.ROOMFRAME_TEST_DB_NAME ?? 'roomframe_test',
    dbUser: process.env.ROOMFRAME_TEST_DB_USER ?? 'roomframe',
    postgresPassword: process.env.ROOMFRAME_TEST_DB_PASSWORD ?? '',
    bootstrapToken,
    sessionSecret: token(),
    totpEncryptionKey: crypto.randomBytes(32).toString('base64'),
  });
  if (!/(?:^|_)test(?:$|_)/.test(config.database.database)) {
    throw new Error('integration_database_must_be_dedicated_to_tests');
  }
  const resetPool = createPool({
    ...config.database,
    application_name: 'roomframe-integration-reset',
  });
  await resetPool.query('DROP SCHEMA public CASCADE');
  await resetPool.query('CREATE SCHEMA public');
  await resetPool.end();
  const { app, pool } = await buildApp({ config, logger: false });
  t.after(() => app.close());

  const statusBefore = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
  assert.equal(statusBefore.statusCode, 200);
  assert.equal(statusBefore.json().configured, false);

  const candidateUsernames = ['owner-one', 'owner-two'];
  const challengeResponses = await Promise.all(candidateUsernames.map((username) => app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/totp',
    payload: { bootstrapToken, username },
  })));
  challengeResponses.forEach((response) => assert.equal(response.statusCode, 201));
  const challenges = challengeResponses.map((response) => response.json());

  const completions = await Promise.all(challenges.map((challenge, index) => app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/complete',
    payload: {
      bootstrapToken,
      challengeId: challenge.challengeId,
      totpCode: totpNow(challenge.secret),
      displayName: 'Organisation de test',
      roomName: `Salle ${index + 1}`,
      defaultGreeting: 'Bonjour, bienvenue dans cette salle',
      branding: { primary: '#151511', accent: '#ff4f1f' },
      policies: {
        returnHomeWhenInactiveMinutes: 15,
        homeSleepMinutes: 30,
        powerScheduleEnabled: false,
      },
      bootstrapAdmin: {
        username: candidateUsernames[index],
        email: `owner-${index + 1}@example.test`,
        password: `Correct-Horse-Battery-${index + 7}!`,
      },
    },
  })));
  const success = completions.find((response) => response.statusCode === 201);
  const conflict = completions.find((response) => response.statusCode === 409);
  assert.ok(success, completions.map((response) => response.statusCode));
  assert.ok(conflict, completions.map((response) => response.statusCode));

  const databaseState = await pool.query(`
    SELECT
      (SELECT count(*) FROM roomframe_instance) AS instances,
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM experience_seed_history) AS seeds
  `);
  assert.deepEqual(
    databaseState.rows[0],
    { instances: '1', users: '1', seeds: '1' },
  );
  const credential = await pool.query('SELECT username, password_hash FROM users');
  assert.match(credential.rows[0].password_hash, /^\$argon2id\$/);
  assert.equal(credential.rows[0].password_hash.includes('Correct-Horse'), false);

  const setCookie = success.headers['set-cookie'];
  const cookieText = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  assert.match(cookieText, /__Host-roomframe_session=/);
  assert.match(cookieText, /Secure/i);
  assert.match(cookieText, /HttpOnly/i);
  assert.match(cookieText, /SameSite=Strict/i);
  const cookie = cookieHeader(success);

  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/studio' });
  assert.equal(unauthorized.statusCode, 401);
  const session = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie },
  });
  assert.equal(session.statusCode, 200);
  const csrfToken = session.json().csrfToken;

  const makeRoleSession = async (role, username) => {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionToken = token();
    const roleCsrf = csrfTokenForSession(sessionId, config.sessionSecret);
    await pool.query(
      `INSERT INTO users (
         id, username, password_hash, role_id, totp_secret_encrypted
       ) VALUES (
         $1, $2, 'not-used-by-this-test',
         (SELECT id FROM roles WHERE slug = $3),
         '{"version":1}'::jsonb
       )`,
      [userId, username, role],
    );
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [
        sessionId,
        userId,
        keyedDigest(sessionToken, config.sessionSecret),
        keyedDigest(roleCsrf, config.sessionSecret),
      ],
    );
    return `${'__Host-roomframe_session'}=${sessionToken}`;
  };
  const contentCookie = await makeRoleSession('content', 'content-test');
  const contentStudio = await app.inject({
    method: 'GET',
    url: '/api/v1/studio',
    headers: { cookie: contentCookie },
  });
  assert.equal(contentStudio.statusCode, 200);
  assert.deepEqual(contentStudio.json().tvs, []);
  assert.deepEqual(contentStudio.json().sourceSettings, []);
  assert.deepEqual(contentStudio.json().releases, []);
  const securityCookie = await makeRoleSession('security', 'security-test');
  const forbiddenPreview = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/sync?deviceId=simulator',
    headers: { cookie: securityCookie },
  });
  assert.equal(forbiddenPreview.statusCode, 403);

  const foreignOrigin = await app.inject({
    method: 'POST',
    url: '/api/v1/messages',
    headers: {
      cookie,
      origin: 'https://not-roomframe.test',
      'x-csrf-token': csrfToken,
    },
    payload: { title: 'Refusé', body: 'Origine étrangère' },
  });
  assert.equal(foreignOrigin.statusCode, 403);
  const fallbackOrigin = await app.inject({
    method: 'POST',
    url: '/api/v1/messages',
    headers: {
      cookie,
      origin: 'https://192.0.2.20',
      'x-csrf-token': csrfToken,
    },
    payload: { title: 'Information', body: 'Origine IP de secours', priority: 10 },
  });
  assert.equal(fallbackOrigin.statusCode, 201);
  const invalidPriority = await app.inject({
    method: 'POST',
    url: '/api/v1/messages',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { title: 'Invalide', body: 'Priorité invalide', priority: 'NaN' },
  });
  assert.equal(invalidPriority.statusCode, 400);

  const enrollment = await app.inject({
    method: 'POST',
    url: '/api/v1/tvs/enrollment',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      displayName: 'TV de test',
      roomName: 'Salle de test',
    },
  });
  assert.equal(enrollment.statusCode, 201);
  const pendingDevice = enrollment.json();
  const pendingSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': pendingDevice.enrollmentKey,
    },
  });
  assert.equal(pendingSync.statusCode, 401);
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: pendingDevice.id,
      enrollmentKey: pendingDevice.enrollmentKey,
    },
  });
  assert.equal(claimed.statusCode, 201);
  const deviceCredential = claimed.json();
  assert.equal(deviceCredential.credentialDelivery, 'one-time');
  const deviceSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(deviceSync.statusCode, 200);
  const unrelatedDefaultAsset = await app.inject({
    method: 'GET',
    url: `/api/v1/default-assets/background-default.jpg?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(unrelatedDefaultAsset.statusCode, 404);
  const assignedDefaultAsset = await app.inject({
    method: 'GET',
    url: `/api/v1/default-assets/background-default.webp?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(assignedDefaultAsset.statusCode, 200);
  assert.equal(assignedDefaultAsset.headers['content-type'], 'image/webp');

  const studio = await app.inject({
    method: 'GET',
    url: '/api/v1/studio',
    headers: { cookie },
  });
  assert.equal(studio.statusCode, 200);
  const studioState = studio.json();
  assert.equal(studioState.scene.currentRevision, 1);
  assert.equal(studioState.measuredMetrics, null);

  const noCsrf = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${studioState.scene.id}/revisions`,
    headers: { cookie },
    payload: {
      baseRevision: 1,
      scene: studioState.scene.document,
      changeSummary: 'Sans CSRF',
    },
  });
  assert.equal(noCsrf.statusCode, 403);

  const sceneWithMissingMedia = structuredClone(studioState.scene.document);
  const missingAssetId = crypto.randomUUID();
  const logoNode = sceneWithMissingMedia.nodes.find((node) => node.kind === 'logo');
  logoNode.props = { assetId: missingAssetId, fit: 'contain', anchor: 'bottom-right' };
  const invalidMediaRevision = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${studioState.scene.id}/revisions`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      baseRevision: 1,
      scene: sceneWithMissingMedia,
      changeSummary: 'Référence média absente',
    },
  });
  assert.equal(invalidMediaRevision.statusCode, 201);
  assert.equal(invalidMediaRevision.json().revision, 2);
  const rejectedPublication = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${studioState.scene.id}/publish`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { revision: 2 },
  });
  assert.equal(rejectedPublication.statusCode, 409);
  assert.equal(rejectedPublication.json().error, 'scene_assets_not_ready');

  const personalizedScene = structuredClone(studioState.scene.document);
  const greetingNode = personalizedScene.nodes.find(
    (node) => node.kind === 'text' && node.props?.role === 'greeting',
  );
  greetingNode.props.text = 'Bonjour, personnalisation conservée après mise à jour';
  const revision = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${studioState.scene.id}/revisions`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      baseRevision: 2,
      scene: personalizedScene,
      changeSummary: 'Personnalisation à conserver',
    },
  });
  assert.equal(revision.statusCode, 201);
  assert.equal(revision.json().revision, 3);

  const publication = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${studioState.scene.id}/publish`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { revision: 3 },
  });
  assert.equal(publication.statusCode, 200);
  assert.equal(publication.json().published, true);

  await pool.query(
    "UPDATE screens SET last_seen_at = TIMESTAMPTZ '2000-01-01T00:00:00Z' WHERE enrollment_state = 'simulated'",
  );
  const sync = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/sync?deviceId=simulator',
    headers: { cookie },
  });
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.json().upToDate, false);
  assert.match(sync.json().manifest.sha256, /^[a-f0-9]{64}$/);
  const previewPresence = await pool.query(
    "SELECT last_seen_at FROM screens WHERE enrollment_state = 'simulated'",
  );
  assert.equal(previewPresence.rows[0].last_seen_at.toISOString(), '2000-01-01T00:00:00.000Z');
  const cachedRevision = sync.json().revision;
  const upToDate = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=simulator&revision=${cachedRevision}`,
    headers: { cookie },
  });
  assert.deepEqual(upToDate.json(), { upToDate: true, revision: cachedRevision });

  const statusAfter = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
  assert.equal(statusAfter.json().configured, true);
  const locked = await app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/totp',
    payload: { bootstrapToken, username: 'another-owner' },
  });
  assert.equal(locked.statusCode, 409);

  await runMigrations(pool, config.migrationsDir);
  const seedsAfterMigrations = await pool.query('SELECT count(*) AS count FROM experience_seed_history');
  assert.equal(seedsAfterMigrations.rows[0].count, '1');
  const personalizedAfterMigrations = await pool.query(
    `SELECT s.published_revision, r.document
     FROM scenes s
     JOIN scene_revisions r
       ON r.scene_id = s.id AND r.revision = s.published_revision
     WHERE s.id = $1`,
    [studioState.scene.id],
  );
  assert.equal(personalizedAfterMigrations.rows[0].published_revision, '3');
  assert.equal(
    personalizedAfterMigrations.rows[0].document.nodes.find(
      (node) => node.kind === 'text' && node.props?.role === 'greeting',
    ).props.text,
    'Bonjour, personnalisation conservée après mise à jour',
  );

  const recoveryToken = token();
  await mkdir(path.dirname(config.recoveryRequestFile), { recursive: true });
  await writeFile(config.recoveryRequestFile, `${JSON.stringify({
    tokenHash: crypto.createHash('sha256').update(recoveryToken).digest('hex'),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    consumedAt: null,
  })}\n`, { mode: 0o600 });
  const recoveredUsername = credential.rows[0].username;
  const recoveryChallengeResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery/totp',
    payload: { recoveryToken, username: recoveredUsername },
  });
  assert.equal(recoveryChallengeResponse.statusCode, 201);
  const recoveryChallenge = recoveryChallengeResponse.json();
  const wrongSubject = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery/complete',
    payload: {
      recoveryToken,
      username: 'other-owner',
      challengeId: recoveryChallenge.challengeId,
      totpCode: totpNow(recoveryChallenge.secret),
      password: 'Another-Correct-Recovery-Password-8!',
    },
  });
  assert.equal(wrongSubject.statusCode, 403);
  const recovered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery/complete',
    payload: {
      recoveryToken,
      username: recoveredUsername,
      challengeId: recoveryChallenge.challengeId,
      totpCode: totpNow(recoveryChallenge.secret),
      password: 'Another-Correct-Recovery-Password-8!',
    },
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().recovered, true);
  const replayedRecovery = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/recovery/complete',
    payload: {
      recoveryToken,
      username: recoveredUsername,
      challengeId: recoveryChallenge.challengeId,
      totpCode: totpNow(recoveryChallenge.secret),
      password: 'Another-Correct-Recovery-Password-9!',
    },
  });
  assert.equal(replayedRecovery.statusCode, 403);
});
