import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildApp } from '../src/app.mjs';
import { buildTestUpdate } from '../scripts/build-test-update.mjs';
import { loadConfig } from '../src/config.mjs';
import { createPool, runMigrations } from '../src/database.mjs';
import { pollGithubUpdates } from '../src/github-update-poller.mjs';
import { processOneMediaJob } from '../src/media-worker.mjs';
import { importReleaseBundle } from '../src/release-importer.mjs';
import { processSceneScheduleTransitions } from '../src/scene-scheduler.mjs';
import { csrfTokenForSession, keyedDigest } from '../src/security.mjs';
import { tvCertificateProofPayload } from '../src/studio-routes.mjs';
import { totpAtCounter } from '../src/totp.mjs';
import {
  ENROLLMENT_CODE_BOOTSTRAP_CONTEXT,
  enrollmentCodeLookupId,
  loadServerCa,
  normalizeEnrollmentCode,
} from '../src/trust-bootstrap.mjs';
import {
  createAuthenticationResponse,
  createRegistrationFixture,
} from './webauthn-fixture.mjs';

const databaseHost = process.env.ROOMFRAME_TEST_DB_HOST;
const splitDatabaseRoles = process.env.ROOMFRAME_TEST_DB_SPLIT_ROLES === '1';
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

const multipartFile = ({ filename, mime, contents }) => {
  const boundary = `roomframe-${crypto.randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${mime}\r\n\r\n`,
    ),
    contents,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  };
};

const decryptTrustBootstrap = ({
  payload,
  deviceId,
  enrollmentKey,
}) => {
  assert.equal(payload.version, 1);
  assert.equal(payload.algorithm, 'AES-256-GCM');
  assert.equal(payload.keyDerivation, 'HKDF-SHA256');
  assert.equal(payload.context, 'roomframe-server-ca-bootstrap-v1');
  const info = Buffer.from(`${payload.context}\n${deviceId}`, 'utf8');
  const keyMaterial = Buffer.from(enrollmentKey, 'base64url');
  const salt = Buffer.from(payload.salt, 'base64url');
  const iv = Buffer.from(payload.iv, 'base64url');
  const tag = Buffer.from(payload.tag, 'base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', keyMaterial, salt, info, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(info);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

const decryptEnrollmentCodeBootstrap = ({ payload, enrollmentCode }) => {
  assert.equal(payload.version, 1);
  assert.equal(payload.algorithm, 'AES-256-GCM');
  assert.equal(payload.keyDerivation, 'HKDF-SHA256');
  assert.equal(payload.context, ENROLLMENT_CODE_BOOTSTRAP_CONTEXT);
  const info = Buffer.from(payload.context, 'utf8');
  const normalizedCode = normalizeEnrollmentCode(enrollmentCode);
  const inputKeyMaterial = crypto
    .createHash('sha256')
    .update(`${payload.context}\0`, 'utf8')
    .update(normalizedCode, 'ascii')
    .digest();
  const salt = Buffer.from(payload.salt, 'base64url');
  const iv = Buffer.from(payload.iv, 'base64url');
  const tag = Buffer.from(payload.tag, 'base64url');
  const key = Buffer.from(crypto.hkdfSync('sha256', inputKeyMaterial, salt, info, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(info);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8'));
};

test('bootstrap concurrent, auth, mise à jour personnalisée et cache TV restent cohérents', {
  skip: !databaseHost,
  timeout: 120_000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'roomframe-integration-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const tvClientCaFile = path.join(temporary, 'tv-client-ca.crt');
  await writeFile(
    tvClientCaFile,
    `-----BEGIN CERTIFICATE-----\n${'A'.repeat(600)}\n-----END CERTIFICATE-----\n`,
    { mode: 0o600 },
  );
  const serverCaFile = process.env.ROOMFRAME_TEST_SERVER_CA_FILE;
  assert.ok(serverCaFile, 'ROOMFRAME_TEST_SERVER_CA_FILE est requis');
  const serverCaPem = await readFile(serverCaFile, 'utf8');
  await assert.rejects(
    loadServerCa(tvClientCaFile),
    (error) => error?.message === 'server_ca_invalid' && error?.statusCode === 503,
  );
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
    tvClientCaFile,
    serverCaFile,
    updateGithubRepository: 'example/roomframe',
    updateGithubChannel: 'stable',
    updatePollMinutes: 360,
    updateRequestTimeoutMs: 5_000,
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
  if (!splitDatabaseRoles) {
    const resetPool = createPool({
      ...config.database,
      application_name: 'roomframe-integration-reset',
    });
    await resetPool.query('DROP SCHEMA public CASCADE');
    await resetPool.query('CREATE SCHEMA public');
    await runMigrations(resetPool, config.migrationsDir);
    await resetPool.end();
  }
  const { app, pool, validators } = await buildApp({
    config,
    logger: process.env.ROOMFRAME_TEST_LOG === '1',
  });
  t.after(() => app.close());

  if (splitDatabaseRoles) {
    const privileges = await pool.query(`
      SELECT
        current_user = 'roomframe_runtime' AS runtime_identity,
        pg_get_userbyid(database.datdba) = 'roomframe_owner' AS owner_identity,
        has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
        NOT has_database_privilege(current_user, current_database(), 'CREATE') AS cannot_create_db,
        NOT has_database_privilege(current_user, current_database(), 'TEMP') AS cannot_create_temp,
        has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
        NOT has_schema_privilege(current_user, 'public', 'CREATE') AS cannot_create_schema,
        has_table_privilege(
          current_user,
          'public.users',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS can_use_tables,
        NOT has_table_privilege(
          current_user,
          'public.schema_migrations',
          'SELECT'
        ) AS cannot_read_migrations,
        NOT pg_has_role(current_user, 'roomframe_owner', 'MEMBER') AS cannot_assume_owner
      FROM pg_database database
      WHERE database.datname = current_database()
    `);
    assert.deepEqual(privileges.rows[0], {
      runtime_identity: true,
      owner_identity: true,
      can_connect: true,
      cannot_create_db: true,
      cannot_create_temp: true,
      can_use_schema: true,
      cannot_create_schema: true,
      can_use_tables: true,
      cannot_read_migrations: true,
      cannot_assume_owner: true,
    });
    await assert.rejects(
      pool.query('CREATE TABLE public.runtime_ddl_must_fail (id integer)'),
      (error) => error?.code === '42501',
    );
    await assert.rejects(
      pool.query('SELECT version FROM public.schema_migrations LIMIT 1'),
      (error) => error?.code === '42501',
    );
  }

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
      defaultGreeting: 'Bonjour,\n  bienvenue en salle de réunion 1',
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
  const ownerIndex = completions.indexOf(success);
  const ownerUsername = candidateUsernames[ownerIndex];
  const ownerPassword = `Correct-Horse-Battery-${ownerIndex + 7}!`;
  const ownerTotpSecret = challenges[ownerIndex].secret;

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
  const wrongPasskeyOrigin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkeys/registration/options',
    headers: {
      cookie,
      origin: config.fallbackUrl,
      'x-csrf-token': csrfToken,
    },
    payload: {
      label: 'Mac de régie',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret, 1),
    },
  });
  assert.equal(wrongPasskeyOrigin.statusCode, 409);
  assert.equal(
    wrongPasskeyOrigin.json().error,
    'passkey_canonical_origin_required',
  );
  assert.equal(wrongPasskeyOrigin.json().preferredUrl, config.preferredUrl);

  const registrationOptionsResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkeys/registration/options',
    headers: {
      cookie,
      origin: config.preferredUrl,
      'x-csrf-token': csrfToken,
    },
    payload: {
      label: 'Mac de régie',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret, 1),
    },
  });
  assert.equal(
    registrationOptionsResponse.statusCode,
    201,
    registrationOptionsResponse.body,
  );
  const registrationChallenge = registrationOptionsResponse.json();
  assert.equal(
    registrationChallenge.options.authenticatorSelection.userVerification,
    'required',
  );
  assert.equal(registrationChallenge.options.rp.id, 'roomframe.test');
  const passkeyFixture = createRegistrationFixture({
    options: registrationChallenge.options,
    origin: config.preferredUrl,
    rpID: 'roomframe.test',
  });
  const registeredPasskey = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkeys/registration/complete',
    headers: {
      cookie,
      origin: config.preferredUrl,
      'x-csrf-token': csrfToken,
    },
    payload: {
      challengeId: registrationChallenge.challengeId,
      label: 'Mac de régie',
      response: passkeyFixture.response,
    },
  });
  assert.equal(registeredPasskey.statusCode, 201, registeredPasskey.body);
  assert.equal(registeredPasskey.json().passkey.label, 'Mac de régie');
  assert.equal(registeredPasskey.json().passkey.deviceType, 'singleDevice');

  const passkeys = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/passkeys',
    headers: { cookie },
  });
  assert.equal(passkeys.statusCode, 200);
  assert.equal(passkeys.json().passkeys.length, 1);
  assert.equal(passkeys.json().canonicalUrl, config.preferredUrl);

  const passkeyLoginOptionsResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkey/options',
    headers: { origin: config.preferredUrl },
    payload: {
      username: ownerUsername,
      password: ownerPassword,
    },
  });
  assert.equal(
    passkeyLoginOptionsResponse.statusCode,
    201,
    passkeyLoginOptionsResponse.body,
  );
  const passkeyLoginChallenge = passkeyLoginOptionsResponse.json();
  const passkeyAuthentication = createAuthenticationResponse({
    options: passkeyLoginChallenge.options,
    origin: config.preferredUrl,
    rpID: 'roomframe.test',
    fixture: passkeyFixture,
  });
  const passkeyLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkey/complete',
    headers: { origin: config.preferredUrl },
    payload: {
      challengeId: passkeyLoginChallenge.challengeId,
      response: passkeyAuthentication,
    },
  });
  assert.equal(passkeyLogin.statusCode, 200, passkeyLogin.body);
  assert.equal(passkeyLogin.json().user.username, ownerUsername);
  const passkeyCookie = cookieHeader(passkeyLogin);
  assert.match(passkeyCookie, /^__Host-roomframe_session=/);
  const passkeyCsrf = passkeyLogin.json().csrfToken;
  const replayedPasskey = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/passkey/complete',
    headers: { origin: config.preferredUrl },
    payload: {
      challengeId: passkeyLoginChallenge.challengeId,
      response: passkeyAuthentication,
    },
  });
  assert.equal(replayedPasskey.statusCode, 403);

  const activeSessions = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    headers: { cookie: passkeyCookie },
  });
  assert.equal(activeSessions.statusCode, 200);
  assert.equal(activeSessions.json().sessions.length, 2);
  const currentPasskeySession = activeSessions.json().sessions.find(
    (entry) => entry.current,
  );
  assert.ok(currentPasskeySession);
  const revokedCurrentSession = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/sessions/${currentPasskeySession.id}/revoke`,
    headers: {
      cookie: passkeyCookie,
      'x-csrf-token': passkeyCsrf,
    },
  });
  assert.equal(revokedCurrentSession.statusCode, 200);
  assert.equal(revokedCurrentSession.json().current, true);
  assert.match(
    String(revokedCurrentSession.headers['set-cookie']),
    /__Host-roomframe_session=;/,
  );
  const revokedSessionAccess = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: passkeyCookie },
  });
  assert.equal(revokedSessionAccess.statusCode, 401);

  await pool.query(
    'UPDATE users SET last_totp_counter = NULL WHERE username = $1',
    [ownerUsername],
  );
  const invitationWithoutCsrf = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { cookie },
    payload: {
      username: 'editor-invited',
      email: 'editor-invited@example.test',
      role: 'content',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(invitationWithoutCsrf.statusCode, 403);
  const invitedUserResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: {
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: {
      username: 'editor-invited',
      email: 'editor-invited@example.test',
      role: 'content',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(invitedUserResponse.statusCode, 201, invitedUserResponse.body);
  const invitedUser = invitedUserResponse.json().user;
  const activationToken = invitedUserResponse.json().invitation.activationToken;
  assert.equal(invitedUser.status, 'pending');
  assert.match(activationToken, /^[A-Za-z0-9_-]{40,128}$/);
  const storedInvitation = await pool.query(
    `SELECT token_hash
     FROM user_invitations
     WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [invitedUser.id],
  );
  assert.equal(storedInvitation.rowCount, 1);
  assert.notEqual(storedInvitation.rows[0].token_hash, activationToken);
  assert.equal(
    storedInvitation.rows[0].token_hash,
    crypto.createHash('sha256').update(activationToken).digest('hex'),
  );

  const listedPendingUsers = await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { cookie },
  });
  assert.equal(listedPendingUsers.statusCode, 200);
  assert.equal(
    listedPendingUsers.json().users.find((user) => user.id === invitedUser.id).status,
    'pending',
  );
  assert.equal(listedPendingUsers.body.includes(activationToken), false);

  const invalidActivation = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activation/totp',
    payload: { activationToken: token() },
  });
  assert.equal(invalidActivation.statusCode, 403);
  const activationTotp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activation/totp',
    payload: { activationToken },
  });
  assert.equal(activationTotp.statusCode, 201, activationTotp.body);
  assert.equal(activationTotp.json().username, 'editor-invited');
  assert.equal(activationTotp.json().role, 'content');
  assert.match(activationTotp.json().secret, /^[A-Z2-7]+$/);

  const invitedPassword = 'Invited-Editor-Password-74!';
  const activatedUserResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activation/complete',
    payload: {
      activationToken,
      challengeId: activationTotp.json().challengeId,
      password: invitedPassword,
      totpCode: totpNow(activationTotp.json().secret),
    },
  });
  assert.equal(activatedUserResponse.statusCode, 200, activatedUserResponse.body);
  assert.equal(activatedUserResponse.json().user.role, 'content');
  const invitedCookie = cookieHeader(activatedUserResponse);
  assert.match(invitedCookie, /^__Host-roomframe_session=/);
  const replayedActivation = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activation/complete',
    payload: {
      activationToken,
      challengeId: activationTotp.json().challengeId,
      password: invitedPassword,
      totpCode: totpNow(activationTotp.json().secret),
    },
  });
  assert.equal(replayedActivation.statusCode, 403);
  const invitedStudio = await app.inject({
    method: 'GET',
    url: '/api/v1/studio',
    headers: { cookie: invitedCookie },
  });
  assert.equal(invitedStudio.statusCode, 200);
  const invitedCannotProvision = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: {
      cookie: invitedCookie,
      'x-csrf-token': activatedUserResponse.json().csrfToken,
    },
    payload: {
      username: 'privilege-escalation',
      email: null,
      role: 'owner',
      password: invitedPassword,
      totpCode: totpNow(activationTotp.json().secret, 1),
    },
  });
  assert.equal(invitedCannotProvision.statusCode, 403);

  await pool.query(
    'UPDATE users SET last_totp_counter = NULL WHERE username = $1',
    [ownerUsername],
  );
  const changedInvitedRole = await app.inject({
    method: 'POST',
    url: `/api/v1/users/${invitedUser.id}/role`,
    headers: {
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: {
      role: 'fleet',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(changedInvitedRole.statusCode, 200, changedInvitedRole.body);
  assert.equal(changedInvitedRole.json().user.role, 'fleet');
  const revokedAfterRoleChange = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: invitedCookie },
  });
  assert.equal(revokedAfterRoleChange.statusCode, 401);

  const ownerRecord = listedPendingUsers.json().users.find(
    (user) => user.username === ownerUsername,
  );
  await pool.query(
    'UPDATE users SET last_totp_counter = NULL WHERE username = $1',
    [ownerUsername],
  );
  const selfDemotion = await app.inject({
    method: 'POST',
    url: `/api/v1/users/${ownerRecord.id}/role`,
    headers: {
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: {
      role: 'content',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(selfDemotion.statusCode, 409);
  assert.equal(selfDemotion.json().error, 'last_owner_required');

  await pool.query(
    'UPDATE users SET last_totp_counter = NULL WHERE username = $1',
    [ownerUsername],
  );
  const disabledInvitedUser = await app.inject({
    method: 'POST',
    url: `/api/v1/users/${invitedUser.id}/disable`,
    headers: {
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: {
      confirmation: 'editor-invited',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(disabledInvitedUser.statusCode, 200, disabledInvitedUser.body);
  assert.equal(disabledInvitedUser.json().user.status, 'disabled');

  await pool.query(
    'UPDATE users SET last_totp_counter = NULL WHERE username = $1',
    [ownerUsername],
  );
  const reissuedInvitation = await app.inject({
    method: 'POST',
    url: `/api/v1/users/${invitedUser.id}/invitation`,
    headers: {
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: {
      confirmation: 'editor-invited',
      password: ownerPassword,
      totpCode: totpNow(ownerTotpSecret),
    },
  });
  assert.equal(reissuedInvitation.statusCode, 200, reissuedInvitation.body);
  assert.equal(reissuedInvitation.json().user.status, 'pending');
  assert.notEqual(
    reissuedInvitation.json().invitation.activationToken,
    activationToken,
  );
  const oldTokenRejected = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activation/totp',
    payload: { activationToken },
  });
  assert.equal(oldTokenRejected.statusCode, 403);

  const releaseStateBefore = await app.inject({
    method: 'GET',
    url: '/api/v1/releases',
    headers: { cookie },
  });
  assert.equal(releaseStateBefore.statusCode, 200, releaseStateBefore.body);
  assert.equal(releaseStateBefore.json().policy.mode, 'manual');
  assert.equal(releaseStateBefore.json().policy.minimumImportAgeMinutes, 60);
  const policyClock = (date) => (
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  );
  const automaticWindowStart = policyClock(new Date(Date.now() - 60 * 60 * 1000));
  const automaticWindowEnd = policyClock(new Date(Date.now() + 60 * 60 * 1000));
  const automaticPolicyPayload = {
    mode: 'automatic',
    minimumImportAgeMinutes: 15,
    windowStart: automaticWindowStart,
    windowEnd: automaticWindowEnd,
    timezone: 'UTC',
  };
  const policyWithoutCsrf = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/server-updates',
    headers: { cookie },
    payload: {
      ...automaticPolicyPayload,
      confirmation: 'ACTIVER LES MISES A JOUR AUTOMATIQUES',
    },
  });
  assert.equal(policyWithoutCsrf.statusCode, 403);
  const policyWithoutConfirmation = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/server-updates',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: automaticPolicyPayload,
  });
  assert.equal(policyWithoutConfirmation.statusCode, 400);
  assert.equal(
    policyWithoutConfirmation.json().error,
    'server_update_automatic_confirmation_required',
  );
  const automaticPolicy = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/server-updates',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      ...automaticPolicyPayload,
      confirmation: 'ACTIVER LES MISES A JOUR AUTOMATIQUES',
    },
  });
  assert.equal(automaticPolicy.statusCode, 200, automaticPolicy.body);
  assert.equal(automaticPolicy.json().policy.mode, 'automatic');
  assert.equal(automaticPolicy.json().policy.timezone, 'UTC');

  const uploadedImage = await sharp({
    create: {
      width: 96,
      height: 54,
      channels: 4,
      background: { r: 26, g: 108, b: 155, alpha: 1 },
    },
  }).png().toBuffer();
  const uploadParts = multipartFile({
    filename: 'image-neutre.png',
    mime: 'image/png',
    contents: uploadedImage,
  });
  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: {
      ...uploadParts.headers,
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: uploadParts.body,
  });
  assert.equal(upload.statusCode, 202, upload.body);
  const queuedAsset = upload.json();
  assert.equal(queuedAsset.status, 'queued');
  assert.match(queuedAsset.sha256, /^[a-f0-9]{64}$/);

  assert.equal(await processOneMediaJob(pool, config, 'integration-worker'), true);
  const processedAsset = await pool.query('SELECT * FROM assets WHERE id = $1', [queuedAsset.id]);
  assert.equal(processedAsset.rows[0].processing_status, 'ready');
  assert.ok(processedAsset.rows[0].variants.thumbnail);
  assert.ok(processedAsset.rows[0].variants['1080p']);
  const generated1080p = path.join(
    config.mediaDir,
    processedAsset.rows[0].variants['1080p'].path,
  );
  const generatedBytes = await readFile(generated1080p);
  assert.equal(
    crypto.createHash('sha256').update(generatedBytes).digest('hex'),
    processedAsset.rows[0].variants['1080p'].sha256,
  );
  const generatedMetadata = await sharp(generatedBytes).metadata();
  assert.equal(generatedMetadata.format, 'webp');
  assert.equal(generatedMetadata.width, 96);
  assert.equal(generatedMetadata.height, 54);
  assert.equal(generatedMetadata.exif, undefined);
  assert.equal(generatedMetadata.xmp, undefined);

  const deliveredMedia = await app.inject({
    method: 'GET',
    url: `/api/v1/media/${queuedAsset.id}/1080p`,
    headers: { cookie },
  });
  assert.equal(deliveredMedia.statusCode, 200);
  assert.equal(deliveredMedia.headers['content-type'], 'image/webp');
  assert.equal(deliveredMedia.headers['x-content-type-options'], 'nosniff');

  const brandingWithoutCsrf = await app.inject({
    method: 'PUT',
    url: '/api/v1/instance/branding',
    headers: { cookie },
    payload: {
      displayName: 'Atelier de test',
      branding: {
        primary: '#102a43',
        accent: '#1aa6b7',
        surface: '#e8edf0',
        ink: '#14202a',
        muted: '#667684',
        fontPreset: 'studio',
        logoAssetId: queuedAsset.id,
      },
    },
  });
  assert.equal(brandingWithoutCsrf.statusCode, 403);
  const brandingUpdate = await app.inject({
    method: 'PUT',
    url: '/api/v1/instance/branding',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      displayName: 'Atelier de test',
      branding: {
        primary: '#102a43',
        accent: '#1aa6b7',
        surface: '#e8edf0',
        ink: '#14202a',
        muted: '#667684',
        fontPreset: 'studio',
        logoAssetId: queuedAsset.id,
      },
    },
  });
  assert.equal(brandingUpdate.statusCode, 200, brandingUpdate.body);
  assert.equal(brandingUpdate.json().instance.displayName, 'Atelier de test');
  assert.equal(brandingUpdate.json().instance.branding.logoAssetId, queuedAsset.id);
  const publicIdentity = await app.inject({ method: 'GET', url: '/api/v1/bootstrap/status' });
  assert.deepEqual(publicIdentity.json().identity, {
    displayName: 'Atelier de test',
    branding: {
      primary: '#102a43',
      accent: '#1aa6b7',
      surface: '#e8edf0',
      ink: '#14202a',
      muted: '#667684',
      fontPreset: 'studio',
    },
  });

  const duplicateParts = multipartFile({
    filename: 'copie-neutre.png',
    mime: 'image/png',
    contents: uploadedImage,
  });
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: {
      ...duplicateParts.headers,
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: duplicateParts.body,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().id, queuedAsset.id);
  const duplicateState = await pool.query(
    'SELECT count(*) AS assets, (SELECT count(*) FROM media_jobs) AS jobs FROM assets',
  );
  assert.deepEqual(duplicateState.rows[0], { assets: '1', jobs: '1' });

  const invalidParts = multipartFile({
    filename: 'faux-media.jpg',
    mime: 'image/jpeg',
    contents: Buffer.from('ceci ne constitue pas une image'),
  });
  const invalidUpload = await app.inject({
    method: 'POST',
    url: '/api/v1/media',
    headers: {
      ...invalidParts.headers,
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: invalidParts.body,
  });
  assert.equal(invalidUpload.statusCode, 415);
  assert.deepEqual(await readdir(config.processingDir), []);

  const updateFixture = await buildTestUpdate(path.join(temporary, 'api-update'), {
    includeHomeApk: true,
    includeSupplyChain: true,
    serverArtifactKind: 'server-archive',
  });
  await mkdir(config.updateTrustDir, { recursive: true, mode: 0o700 });
  await copyFile(
    updateFixture.publicKeyPath,
    path.join(config.updateTrustDir, 'dev-local.pem'),
  );
  const updateParts = multipartFile({
    filename: 'roomframe-test-0.3.1.rfupdate',
    mime: 'application/octet-stream',
    contents: await readFile(updateFixture.bundlePath),
  });
  const importedUpdate = await app.inject({
    method: 'POST',
    url: '/api/v1/releases/import',
    headers: {
      ...updateParts.headers,
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: updateParts.body,
  });
  assert.equal(importedUpdate.statusCode, 201, importedUpdate.body);
  const importedRelease = importedUpdate.json();
  assert.equal(importedRelease.releaseId, updateFixture.manifest.releaseId);
  assert.equal(importedRelease.status, 'verified');
  assert.match(importedRelease.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(importedRelease.apkArtifacts.length, 1);
  assert.equal(importedRelease.apkArtifacts[0].packageName, 'org.roomframe.tv');
  const wrongServerConfirmation = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/server-update-requests`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmVersion: '0.3.2' },
  });
  assert.equal(wrongServerConfirmation.statusCode, 400);
  const queuedServerUpdate = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/server-update-requests`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmVersion: updateFixture.manifest.version },
  });
  assert.equal(queuedServerUpdate.statusCode, 202, queuedServerUpdate.body);
  assert.equal(queuedServerUpdate.json().status, 'pending');
  const duplicateServerUpdate = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/server-update-requests`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmVersion: updateFixture.manifest.version },
  });
  assert.equal(duplicateServerUpdate.statusCode, 409);
  const quarantinedBundle = await readFile(path.join(
    config.releasesDir,
    'verified',
    `${importedRelease.bundleSha256}.rfupdate`,
  ));
  assert.equal(
    crypto.createHash('sha256').update(quarantinedBundle).digest('hex'),
    importedRelease.bundleSha256,
  );
  let githubRequests = 0;
  const githubPoll = await pollGithubUpdates({
    pool,
    config,
    validators,
    fetchImpl: async (url) => {
      githubRequests += 1;
      if (new URL(url).pathname.endsWith('/releases')) {
        return new Response(JSON.stringify([{
          id: 5001,
          tag_name: 'v0.3.1',
          draft: false,
          prerelease: false,
          published_at: '2026-07-28T12:00:00Z',
          assets: [{
            id: 5002,
            name: 'roomframe-tv-v0.3.1.rfupdate',
            state: 'uploaded',
            size: quarantinedBundle.length,
            digest: `sha256:${importedRelease.bundleSha256}`,
            updated_at: '2026-07-28T12:01:00Z',
            url: 'https://api.github.com/repos/example/roomframe/releases/assets/5002',
          }],
        }]), {
          status: 200,
          headers: { etag: '"integration-update"' },
        });
      }
      return new Response(quarantinedBundle, {
        status: 200,
        headers: { 'content-length': String(quarantinedBundle.length) },
      });
    },
  });
  assert.equal(githubPoll.status, 'already-imported');
  assert.equal(githubPoll.releaseId, importedRelease.releaseId);
  assert.equal(githubRequests, 2);
  const releasesAfterPoll = await app.inject({
    method: 'GET',
    url: '/api/v1/releases',
    headers: { cookie },
  });
  assert.equal(releasesAfterPoll.statusCode, 200, releasesAfterPoll.body);
  assert.equal(releasesAfterPoll.json().source.enabled, true);
  assert.equal(releasesAfterPoll.json().source.repository, 'example/roomframe');
  assert.equal(releasesAfterPoll.json().source.state.lastResult, 'already-imported');
  assert.equal(releasesAfterPoll.json().serverUpdateRequests.length, 1);
  assert.equal(releasesAfterPoll.json().serverUpdateRequests[0].status, 'pending');
  assert.equal(releasesAfterPoll.json().releases[0].has_server_archive, true);
  await pool.query(
    `UPDATE server_update_requests
     SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [queuedServerUpdate.json().id],
  );
  const githubAutoFixture = await buildTestUpdate(
    path.join(temporary, 'api-update-auto-github'),
    {
      version: '0.3.2',
      keyId: 'dev-auto-github',
      includeSupplyChain: true,
      serverArtifactKind: 'server-archive',
    },
  );
  await copyFile(
    githubAutoFixture.publicKeyPath,
    path.join(config.updateTrustDir, 'dev-auto-github.pem'),
  );
  const githubWrongProvenance = path.join(
    temporary,
    'github-wrong-provenance.rfupdate',
  );
  await copyFile(githubAutoFixture.bundlePath, githubWrongProvenance);
  await assert.rejects(
    importReleaseBundle({
      pool,
      config,
      validators,
      source: githubWrongProvenance,
      actor: { actorType: 'system' },
      sourceDetails: {
        provider: 'github',
        repository: 'other/roomframe',
        tagName: 'v0.3.2',
      },
    }),
    /github_update_provenance_mismatch/,
  );
  const githubAutoRelease = await importReleaseBundle({
    pool,
    config,
    validators,
    source: githubAutoFixture.bundlePath,
    actor: { actorType: 'system' },
    sourceDetails: {
      provider: 'github',
      repository: 'example/roomframe',
      tagName: 'v0.3.2',
      externalReleaseId: 6001,
      externalAssetId: 6002,
    },
  });
  const manualNewerFixture = await buildTestUpdate(
    path.join(temporary, 'api-update-manual-newer'),
    {
      version: '0.3.3',
      keyId: 'dev-manual-newer',
      serverArtifactKind: 'server-archive',
    },
  );
  await copyFile(
    manualNewerFixture.publicKeyPath,
    path.join(config.updateTrustDir, 'dev-manual-newer.pem'),
  );
  const manualNewerRelease = await importReleaseBundle({
    pool,
    config,
    validators,
    source: manualNewerFixture.bundlePath,
    actor: { actorType: 'user', session: session.json().session },
    sourceDetails: { provider: 'manual' },
  });
  await pool.query(
    `UPDATE release_history
     SET imported_at = now() - interval '30 minutes'
     WHERE id = ANY($1::uuid[])`,
    [[githubAutoRelease.releaseId, manualNewerRelease.releaseId]],
  );
  const automaticQueueSql = await readFile(
    path.join(root, 'database/queries/queue_automatic_server_update.sql'),
    'utf8',
  );
  const githubSupplyChain = await pool.query(
    'SELECT verification FROM release_history WHERE id = $1',
    [githubAutoRelease.releaseId],
  );
  await pool.query(
    `UPDATE release_history
     SET verification = verification - 'supplyChain'
     WHERE id = $1`,
    [githubAutoRelease.releaseId],
  );
  await pool.query(automaticQueueSql);
  const legacyGithubAutomaticRequest = await pool.query(
    'SELECT count(*) AS count FROM server_update_requests WHERE release_id = $1',
    [githubAutoRelease.releaseId],
  );
  assert.equal(legacyGithubAutomaticRequest.rows[0].count, '0');
  await pool.query(
    'UPDATE release_history SET verification = $2::jsonb WHERE id = $1',
    [
      githubAutoRelease.releaseId,
      JSON.stringify(githubSupplyChain.rows[0].verification),
    ],
  );
  await pool.query(automaticQueueSql);
  const automaticRequest = await pool.query(
    `SELECT id, release_id, requested_by, status
     FROM server_update_requests
     WHERE release_id = $1`,
    [githubAutoRelease.releaseId],
  );
  assert.equal(automaticRequest.rows.length, 1);
  assert.equal(automaticRequest.rows[0].status, 'pending');
  assert.equal(automaticRequest.rows[0].requested_by, null);
  const manualAutomaticRequest = await pool.query(
    'SELECT count(*) AS count FROM server_update_requests WHERE release_id = $1',
    [manualNewerRelease.releaseId],
  );
  assert.equal(manualAutomaticRequest.rows[0].count, '0');
  await pool.query(
    `UPDATE server_update_requests
     SET status = 'failed', last_error_code = 'test_failure',
         completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [automaticRequest.rows[0].id],
  );
  await pool.query(automaticQueueSql);
  const automaticRequestsAfterFailure = await pool.query(
    'SELECT count(*) AS count FROM server_update_requests WHERE requested_by IS NULL',
  );
  assert.equal(automaticRequestsAfterFailure.rows[0].count, '1');
  const automaticAudit = await pool.query(
    "SELECT count(*) AS count FROM audit_log WHERE action = 'release.server_apply_auto_requested'",
  );
  assert.equal(automaticAudit.rows[0].count, '1');
  const equalVersionSource = path.join(temporary, 'equal-version.rfupdate');
  await copyFile(updateFixture.bundlePath, equalVersionSource);
  const equalVersionImport = await importReleaseBundle({
    pool,
    config: { ...config, version: '0.3.1' },
    validators,
    source: equalVersionSource,
    actor: { actorType: 'system' },
    sourceDetails: { provider: 'manual' },
  });
  assert.equal(equalVersionImport.alreadyImported, true);
  assert.equal(equalVersionImport.releaseId, importedRelease.releaseId);

  const invalidUpdateFixture = await buildTestUpdate(
    path.join(temporary, 'api-update-invalid'),
    {
      manifestTextTransform: (manifest) => manifest.replace(
        '"formatVersion": 1,',
        '"formatVersion": 1,\n  "formatVersion": 1,',
      ),
    },
  );
  const invalidUpdateParts = multipartFile({
    filename: 'roomframe-invalide.rfupdate',
    mime: 'application/octet-stream',
    contents: await readFile(invalidUpdateFixture.bundlePath),
  });
  const rejectedUpdate = await app.inject({
    method: 'POST',
    url: '/api/v1/releases/import',
    headers: {
      ...invalidUpdateParts.headers,
      cookie,
      'x-csrf-token': csrfToken,
    },
    payload: invalidUpdateParts.body,
  });
  assert.equal(rejectedUpdate.statusCode, 422, rejectedUpdate.body);
  assert.equal(rejectedUpdate.json().error, 'duplicate_update_manifest_key');
  const releaseCount = await pool.query('SELECT count(*) AS count FROM release_history');
  assert.equal(releaseCount.rows[0].count, '3');
  assert.deepEqual(await readdir(config.processingDir), []);

  const makeRoleSession = async (role, username) => {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionToken = token();
    const roleCsrf = csrfTokenForSession(sessionId, config.sessionSecret);
    await pool.query(
      `INSERT INTO users (
         id, username, password_hash, role_id, totp_secret_encrypted,
         webauthn_user_id
       ) VALUES (
         $1, $2, 'not-used-by-this-test',
         (SELECT id FROM roles WHERE slug = $3),
         '{"version":1}'::jsonb, $4
       )`,
      [userId, username, role, Buffer.from(userId.replaceAll('-', ''), 'hex')],
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
  const contentSession = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie: contentCookie },
  });
  assert.equal(contentSession.statusCode, 200, contentSession.body);
  const contentCsrfToken = contentSession.json().csrfToken;
  const contentStudio = await app.inject({
    method: 'GET',
    url: '/api/v1/studio',
    headers: { cookie: contentCookie },
  });
  assert.equal(contentStudio.statusCode, 200);
  assert.deepEqual(contentStudio.json().tvs, []);
  assert.deepEqual(contentStudio.json().sourceSettings, []);
  assert.deepEqual(contentStudio.json().releases, []);
  assert.deepEqual(contentStudio.json().serverUpdateRequests, []);
  assert.equal(contentStudio.json().serverUpdatePolicy, null);
  const forbiddenServerUpdateRequest = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/server-update-requests`,
    headers: { cookie: contentCookie },
    payload: { confirmVersion: updateFixture.manifest.version },
  });
  assert.equal(forbiddenServerUpdateRequest.statusCode, 403);
  const forbiddenServerUpdatePolicy = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/server-updates',
    headers: { cookie: contentCookie },
    payload: {
      mode: 'manual',
      minimumImportAgeMinutes: 60,
      windowStart: '02:00',
      windowEnd: '05:00',
      timezone: 'UTC',
    },
  });
  assert.equal(forbiddenServerUpdatePolicy.statusCode, 403);
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
  assert.deepEqual(pendingDevice.trustBootstrap, {
    mode: 'encrypted-server-ca',
    version: 1,
  });
  assert.deepEqual(pendingDevice.simplifiedEnrollment, {
    mode: 'encrypted-code-bootstrap',
    version: 1,
  });
  assert.match(
    pendingDevice.enrollmentCode,
    /^\d{4}(?:-\d{4}){3}$/,
  );
  const codeBootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enrollment-bootstrap',
    payload: {
      enrollmentCodeId: enrollmentCodeLookupId(pendingDevice.enrollmentCode),
    },
  });
  assert.equal(codeBootstrap.statusCode, 200, codeBootstrap.body);
  const resolvedEnrollment = decryptEnrollmentCodeBootstrap({
    payload: codeBootstrap.json(),
    enrollmentCode: pendingDevice.enrollmentCode,
  });
  assert.equal(resolvedEnrollment.deviceId, pendingDevice.id);
  assert.equal(resolvedEnrollment.enrollmentKey, pendingDevice.enrollmentKey);
  assert.equal(resolvedEnrollment.certificatePem, serverCaPem);
  assert.equal(
    resolvedEnrollment.certificateFingerprintSha256,
    (await loadServerCa(serverCaFile)).fingerprintSha256,
  );
  const invalidCodeBootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enrollment-bootstrap',
    payload: { enrollmentCodeId: 'not-a-code-id' },
  });
  assert.equal(invalidCodeBootstrap.statusCode, 404);
  const clearCodeBootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enrollment-bootstrap',
    payload: { enrollmentCode: pendingDevice.enrollmentCode },
  });
  assert.equal(clearCodeBootstrap.statusCode, 404);
  const trustBootstrap = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/trust-bootstrap?deviceId=${pendingDevice.id}`,
  });
  assert.equal(trustBootstrap.statusCode, 200, trustBootstrap.body);
  assert.equal(
    decryptTrustBootstrap({
      payload: trustBootstrap.json(),
      deviceId: pendingDevice.id,
      enrollmentKey: pendingDevice.enrollmentKey,
    }),
    serverCaPem,
  );
  assert.throws(() => decryptTrustBootstrap({
    payload: {
      ...trustBootstrap.json(),
      tag: (
        `${trustBootstrap.json().tag[0] === 'A' ? 'B' : 'A'}`
        + trustBootstrap.json().tag.slice(1)
      ),
    },
    deviceId: pendingDevice.id,
    enrollmentKey: pendingDevice.enrollmentKey,
  }));
  const missingTrustBootstrap = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/trust-bootstrap?deviceId=not-an-uuid',
  });
  assert.equal(missingTrustBootstrap.statusCode, 404);
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
  const consumedTrustBootstrap = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/trust-bootstrap?deviceId=${pendingDevice.id}`,
  });
  assert.equal(consumedTrustBootstrap.statusCode, 404);
  const consumedCodeBootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enrollment-bootstrap',
    payload: {
      enrollmentCodeId: enrollmentCodeLookupId(pendingDevice.enrollmentCode),
    },
  });
  assert.equal(consumedCodeBootstrap.statusCode, 404);
  const deviceCredential = claimed.json();
  assert.equal(deviceCredential.credentialDelivery, 'one-time');
  assert.equal(deviceCredential.credentialGeneration, 1);
  const deviceSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(deviceSync.statusCode, 200);

  const certificateEnrollment = await app.inject({
    method: 'POST',
    url: '/api/v1/tvs/enrollment',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      displayName: 'TV certificat',
      roomName: 'Salle certificat',
    },
  });
  assert.equal(certificateEnrollment.statusCode, 201, certificateEnrollment.body);
  const certificatePendingDevice = certificateEnrollment.json();
  const certificateKeyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const publicKeySpki = certificateKeyPair.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const proofSignature = crypto.sign(
    'RSA-SHA256',
    tvCertificateProofPayload(
      certificatePendingDevice.id,
      certificatePendingDevice.enrollmentKey,
    ),
    certificateKeyPair.privateKey,
  );
  const invalidCertificateProof = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: certificatePendingDevice.id,
      enrollmentKey: certificatePendingDevice.enrollmentKey,
      certificateRequest: {
        algorithm: 'RS256',
        publicKeySpki: publicKeySpki.toString('base64url'),
        proofSignature: crypto.sign(
          'RSA-SHA256',
          Buffer.from('preuve-rejouee-ou-modifiee'),
          certificateKeyPair.privateKey,
        ).toString('base64url'),
      },
    },
  });
  assert.equal(invalidCertificateProof.statusCode, 401);
  const certificateClaim = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: certificatePendingDevice.id,
      enrollmentKey: certificatePendingDevice.enrollmentKey,
      certificateRequest: {
        algorithm: 'RS256',
        publicKeySpki: publicKeySpki.toString('base64url'),
        proofSignature: proofSignature.toString('base64url'),
      },
    },
  });
  assert.equal(certificateClaim.statusCode, 201, certificateClaim.body);
  assert.equal(
    certificateClaim.json().credentialMode,
    'device-key-and-client-certificate',
  );
  assert.equal(certificateClaim.json().certificateStatus, 'pending');
  const certificateDeviceCredentials = certificateClaim.json();
  const certificateHeaders = {
    'x-roomframe-device-id': certificatePendingDevice.id,
    'x-roomframe-device-key': certificateDeviceCredentials.deviceKey,
  };
  const certificatePending = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/certificate',
    headers: certificateHeaders,
  });
  assert.equal(certificatePending.statusCode, 200, certificatePending.body);
  assert.equal(certificatePending.json().status, 'pending');

  const certificateFingerprint = crypto
    .createHash('sha256')
    .update('roomframe-integration-client-certificate')
    .digest('hex');
  const certificateSerial = 'AABBCCDDEEFF00112233445566778899';
  const certificatePem = (
    `-----BEGIN CERTIFICATE-----\n${'B'.repeat(600)}\n-----END CERTIFICATE-----\n`
  );
  const renewedRequestUpdate = await pool.query(
    `UPDATE tv_certificate_requests
     SET status = 'issued',
         certificate_pem = $2,
         certificate_fingerprint_sha256 = $3,
         certificate_serial = $4,
         issued_at = now(),
         expires_at = now() + interval '90 days',
         updated_at = now()
     WHERE id = $1`,
    [
      certificateDeviceCredentials.certificateRequestId,
      certificatePem,
      certificateFingerprint,
      certificateSerial,
    ],
  );
  await pool.query(
    `UPDATE screens
     SET client_certificate_pending_fingerprint = $2,
         client_certificate_pending_serial = $3,
         client_certificate_pending_issued_at = now(),
         client_certificate_pending_expires_at = now() + interval '90 days',
         client_certificate_pending_required_at = now() + interval '24 hours'
     WHERE id = $1`,
    [certificatePendingDevice.id, certificateFingerprint, certificateSerial],
  );
  const certificateIssued = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/certificate',
    headers: certificateHeaders,
  });
  assert.equal(certificateIssued.statusCode, 200, certificateIssued.body);
  assert.equal(certificateIssued.json().status, 'issued');
  assert.equal(certificateIssued.json().certificatePem, certificatePem);
  assert.equal(certificateIssued.json().fingerprintSha256, certificateFingerprint);
  const activationWithoutCertificate = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/certificate/activate',
    headers: certificateHeaders,
    payload: {},
  });
  assert.equal(activationWithoutCertificate.statusCode, 401);
  const activationHeaders = {
    ...certificateHeaders,
    'x-roomframe-tls-client-verified': '1',
    'x-roomframe-tls-client-fingerprint': certificateFingerprint,
  };
  const certificateActivation = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/certificate/activate',
    headers: activationHeaders,
    payload: {},
  });
  assert.equal(certificateActivation.statusCode, 200, certificateActivation.body);
  assert.equal(certificateActivation.json().activated, true);
  assert.equal(certificateActivation.json().idempotent, false);
  const certificateRequired = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${certificatePendingDevice.id}`,
    headers: certificateHeaders,
  });
  assert.equal(certificateRequired.statusCode, 401);
  const certificateAuthenticated = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${certificatePendingDevice.id}`,
    headers: activationHeaders,
  });
  assert.equal(certificateAuthenticated.statusCode, 200, certificateAuthenticated.body);
  const wrongCertificate = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${certificatePendingDevice.id}`,
    headers: {
      ...certificateHeaders,
      'x-roomframe-tls-client-verified': '1',
      'x-roomframe-tls-client-fingerprint': '0'.repeat(64),
    },
  });
  assert.equal(wrongCertificate.statusCode, 401);
  await pool.query(
    `UPDATE screens
     SET client_certificate_expires_at = now() + interval '29 days'
     WHERE id = $1`,
    [certificatePendingDevice.id],
  );
  const certificateRenewal = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/certificate/renew',
    headers: activationHeaders,
    payload: {},
  });
  assert.equal(certificateRenewal.statusCode, 201, certificateRenewal.body);
  assert.equal(certificateRenewal.json().status, 'pending');
  const certificateRenewalRepeated = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/certificate/renew',
    headers: activationHeaders,
    payload: {},
  });
  assert.equal(
    certificateRenewalRepeated.statusCode,
    200,
    certificateRenewalRepeated.body,
  );
  assert.equal(
    certificateRenewalRepeated.json().requestId,
    certificateRenewal.json().requestId,
  );
  assert.equal(certificateRenewalRepeated.json().idempotent, true);
  const renewedFingerprint = crypto
    .createHash('sha256')
    .update('roomframe-integration-renewed-client-certificate')
    .digest('hex');
  const renewedSerial = 'BBCCDDEEFF0011223344556677889900';
  const renewedCertificatePem = (
    `-----BEGIN CERTIFICATE-----\n${'C'.repeat(600)}\n-----END CERTIFICATE-----\n`
  );
  const certificateRenewalRequestUpdate = await pool.query(
    `UPDATE tv_certificate_requests
     SET status = 'issued',
         certificate_pem = $2,
         certificate_fingerprint_sha256 = $3,
         certificate_serial = $4,
         issued_at = now(),
         expires_at = now() + interval '90 days',
         updated_at = now()
     WHERE id = $1`,
    [
      certificateRenewal.json().requestId,
      renewedCertificatePem,
      renewedFingerprint,
      renewedSerial,
    ],
  );
  assert.equal(certificateRenewalRequestUpdate.rowCount, 1);
  const renewedRequestState = await pool.query(
    `SELECT id, status
     FROM tv_certificate_requests
     WHERE screen_id = $1
     ORDER BY updated_at DESC, requested_at DESC, id DESC`,
    [certificatePendingDevice.id],
  );
  assert.equal(renewedRequestState.rows[0].id, certificateRenewal.json().requestId);
  assert.equal(renewedRequestState.rows[0].status, 'issued');
  await pool.query(
    `UPDATE screens
     SET client_certificate_pending_fingerprint = $2,
         client_certificate_pending_serial = $3,
         client_certificate_pending_issued_at = now(),
         client_certificate_pending_expires_at = now() + interval '90 days',
         client_certificate_pending_required_at = now() + interval '24 hours'
     WHERE id = $1`,
    [certificatePendingDevice.id, renewedFingerprint, renewedSerial],
  );
  const renewedCertificateIssued = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/certificate',
    headers: activationHeaders,
  });
  assert.equal(
    renewedCertificateIssued.statusCode,
    200,
    renewedCertificateIssued.body,
  );
  assert.equal(renewedCertificateIssued.json().status, 'issued');
  assert.equal(
    renewedCertificateIssued.json().fingerprintSha256,
    renewedFingerprint,
  );
  const renewedHeaders = {
    ...certificateHeaders,
    'x-roomframe-tls-client-verified': '1',
    'x-roomframe-tls-client-fingerprint': renewedFingerprint,
  };
  const renewedActivation = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/certificate/activate',
    headers: renewedHeaders,
    payload: {},
  });
  assert.equal(renewedActivation.statusCode, 200, renewedActivation.body);
  assert.equal(renewedActivation.json().idempotent, false);
  const retiredCertificate = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${certificatePendingDevice.id}`,
    headers: activationHeaders,
  });
  assert.equal(retiredCertificate.statusCode, 401);
  const renewedCertificateAuthenticated = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${certificatePendingDevice.id}`,
    headers: renewedHeaders,
  });
  assert.equal(
    renewedCertificateAuthenticated.statusCode,
    200,
    renewedCertificateAuthenticated.body,
  );
  await pool.query('DELETE FROM screens WHERE id = $1', [certificatePendingDevice.id]);

  const rotatedDeviceKey = token();
  const preparedRotation = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/credentials/rotate',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: {
      nextKey: rotatedDeviceKey,
      currentGeneration: deviceCredential.credentialGeneration,
    },
  });
  assert.equal(preparedRotation.statusCode, 200, preparedRotation.body);
  assert.equal(preparedRotation.json().nextGeneration, 2);
  const activeKeyDuringRotation = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(activeKeyDuringRotation.statusCode, 200, activeKeyDuringRotation.body);
  const wrongRotationGeneration = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/credentials/confirm',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': rotatedDeviceKey,
    },
    payload: { generation: 3 },
  });
  assert.equal(wrongRotationGeneration.statusCode, 401, wrongRotationGeneration.body);
  const confirmedRotation = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/credentials/confirm',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': rotatedDeviceKey,
    },
    payload: { generation: 2 },
  });
  assert.equal(confirmedRotation.statusCode, 200, confirmedRotation.body);
  assert.equal(confirmedRotation.json().credentialGeneration, 2);
  assert.equal(confirmedRotation.json().idempotent, false);
  const retiredDeviceKey = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(retiredDeviceKey.statusCode, 401, retiredDeviceKey.body);
  const duplicateConfirmation = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/credentials/confirm',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': rotatedDeviceKey,
    },
    payload: { generation: 2 },
  });
  assert.equal(duplicateConfirmation.statusCode, 200, duplicateConfirmation.body);
  assert.equal(duplicateConfirmation.json().idempotent, true);
  deviceCredential.deviceKey = rotatedDeviceKey;
  deviceCredential.credentialGeneration = 2;

  const createdGroup = await app.inject({
    method: 'POST',
    url: '/api/v1/groups',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      name: 'Groupe aperçu',
      description: 'Cible sans TV requise pour prévisualiser les règles de groupe.',
    },
  });
  assert.equal(createdGroup.statusCode, 201, createdGroup.body);
  const groupId = createdGroup.json().id;
  const groupSources = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/sources',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      targetType: 'group',
      targetId: groupId,
      items: [
        {
          kind: 'airplay',
          enabled: true,
          label: 'AirPlay',
          configuration: {
            adapter: 'unsupported',
            serviceName: 'RoomFrame',
            receiverMode: 'isolated',
          },
        },
        {
          kind: 'hdmi',
          enabled: true,
          label: 'HDMI',
          configuration: {
            adapter: 'unsupported',
            physicalInput: 'HDMI1',
            signalProbe: true,
          },
        },
      ],
    },
  });
  assert.equal(groupSources.statusCode, 200, groupSources.body);
  assert.equal(groupSources.json().sourceCount, 2);
  const duplicateGroupSources = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/sources',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      targetType: 'group',
      targetId: groupId,
      items: [
        { kind: 'airplay', label: 'Un', configuration: {} },
        { kind: 'airplay', label: 'Deux', configuration: {} },
      ],
    },
  });
  assert.equal(duplicateGroupSources.statusCode, 400, duplicateGroupSources.body);
  assert.equal(duplicateGroupSources.json().error, 'duplicate_source_kind');
  const privateAppWithoutPackage = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/sources',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      targetType: 'group',
      targetId: groupId,
      items: [{
        kind: 'private-app',
        enabled: true,
        label: 'Application privée',
        configuration: { adapter: 'unsupported' },
      }],
    },
  });
  assert.equal(privateAppWithoutPackage.statusCode, 400, privateAppWithoutPackage.body);
  assert.equal(privateAppWithoutPackage.json().error, 'source_application_id_required');
  const groupPower = await app.inject({
    method: 'PUT',
    url: '/api/v1/settings/power',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      targetType: 'group',
      targetId: groupId,
      timezone: 'Europe/Paris',
      enabled: true,
      returnHomeWhenInactiveMinutes: 12,
      homeSleepMinutes: 25,
      rules: [{
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        wake: '07:30',
        sleep: '20:00',
      }],
    },
  });
  assert.equal(groupPower.statusCode, 200, groupPower.body);
  assert.equal(groupPower.json().capabilityProbeRequired, true);
  const groupPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=group&targetId=${groupId}`,
    headers: { cookie },
  });
  assert.equal(groupPreview.statusCode, 200, groupPreview.body);
  assert.equal(groupPreview.json().target.type, 'group');
  assert.equal(groupPreview.json().target.name, 'Groupe aperçu');
  assert.equal(groupPreview.json().scene.document.schemaVersion, 2);
  assert.equal(groupPreview.json().documents.branding.displayName, 'Atelier de test');
  const resolvedGroupSources = groupPreview.json().documents.sources.items;
  assert.equal(resolvedGroupSources.filter((source) => source.target_type === 'group').length, 2);
  assert.ok(resolvedGroupSources.some((source) => (
    source.source_kind === 'airplay' && source.target_type === 'group'
  )));
  assert.ok(resolvedGroupSources.some((source) => (
    source.source_kind === 'hdmi' && source.target_type === 'group'
  )));
  assert.equal(
    groupPreview.json().documents.schedule.sourcePolicies.returnHomeWhenInactiveMinutes,
    12,
  );
  assert.equal(groupPreview.json().documents.schedule.sourcePolicies.homeSleepMinutes, 25);
  assert.equal(groupPreview.json().documents.schedule.power.enabled, true);
  const tvPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=tv&targetId=${pendingDevice.id}`,
    headers: { cookie },
  });
  assert.equal(tvPreview.statusCode, 200, tvPreview.body);
  assert.equal(tvPreview.json().target.id, pendingDevice.id);
  assert.equal(tvPreview.json().scene.revision, deviceSync.json().manifest.sceneRevision);
  const previewWithoutFleetPermission = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=tv&targetId=${pendingDevice.id}`,
    headers: { cookie: contentCookie },
  });
  assert.equal(previewWithoutFleetPermission.statusCode, 403);
  const missingGroupPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=group&targetId=${crypto.randomUUID()}`,
    headers: { cookie },
  });
  assert.equal(missingGroupPreview.statusCode, 404);

  const plannedDeployment = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/deployments`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      strategy: 'progressive',
      targetType: 'fleet',
      batchSize: 1,
    },
  });
  assert.equal(plannedDeployment.statusCode, 201, plannedDeployment.body);
  const deployment = plannedDeployment.json();
  assert.equal(deployment.status, 'running');
  assert.equal(deployment.offeredCount, 1);
  assert.equal(
    deployment.hardwareExecution,
    'download-and-verification-active-install-requires-device-owner',
  );

  const otherEnrollment = await app.inject({
    method: 'POST',
    url: '/api/v1/tvs/enrollment',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      displayName: 'TV isolée',
      roomName: 'Salle isolée',
    },
  });
  assert.equal(otherEnrollment.statusCode, 201, otherEnrollment.body);
  const otherPendingDevice = otherEnrollment.json();
  const otherClaim = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: otherPendingDevice.id,
      enrollmentKey: otherPendingDevice.enrollmentKey,
    },
  });
  assert.equal(otherClaim.statusCode, 201, otherClaim.body);
  const otherDeviceCredential = otherClaim.json();
  const otherUpdateOffer = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/update',
    headers: {
      'x-roomframe-device-id': otherPendingDevice.id,
      'x-roomframe-device-key': otherDeviceCredential.deviceKey,
    },
  });
  assert.equal(otherUpdateOffer.statusCode, 200, otherUpdateOffer.body);
  assert.equal(otherUpdateOffer.json().available, false);
  const foreignApkDownload = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/updates/${deployment.id}/apk`,
    headers: {
      'x-roomframe-device-id': otherPendingDevice.id,
      'x-roomframe-device-key': otherDeviceCredential.deviceKey,
    },
  });
  assert.equal(foreignApkDownload.statusCode, 403, foreignApkDownload.body);
  const forbiddenRevocation = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${otherPendingDevice.id}/revoke`,
    headers: { cookie: contentCookie, 'x-csrf-token': contentCsrfToken },
    payload: { confirmation: 'REVOQUER LA TV' },
  });
  assert.equal(forbiddenRevocation.statusCode, 403, forbiddenRevocation.body);
  const revocationWithoutCsrf = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${otherPendingDevice.id}/revoke`,
    headers: { cookie },
    payload: { confirmation: 'REVOQUER LA TV' },
  });
  assert.equal(revocationWithoutCsrf.statusCode, 403, revocationWithoutCsrf.body);
  const revokedTv = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${otherPendingDevice.id}/revoke`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'REVOQUER LA TV' },
  });
  assert.equal(revokedTv.statusCode, 200, revokedTv.body);
  assert.equal(revokedTv.json().tv.enrollmentState, 'revoked');
  assert.equal(revokedTv.json().tv.credentialGeneration, 2);
  const revokedCredential = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${otherPendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': otherPendingDevice.id,
      'x-roomframe-device-key': otherDeviceCredential.deviceKey,
    },
  });
  assert.equal(revokedCredential.statusCode, 401, revokedCredential.body);
  const duplicateRevocation = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${otherPendingDevice.id}/revoke`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'REVOQUER LA TV' },
  });
  assert.equal(duplicateRevocation.statusCode, 409, duplicateRevocation.body);
  const reenrollment = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${otherPendingDevice.id}/reenrollment`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'REINITIALISER L ENROLEMENT' },
  });
  assert.equal(reenrollment.statusCode, 200, reenrollment.body);
  assert.equal(reenrollment.json().enrollmentState, 'pending');
  assert.equal(reenrollment.json().credentialGeneration, 3);
  assert.deepEqual(reenrollment.json().trustBootstrap, {
    mode: 'encrypted-server-ca',
    version: 1,
  });
  assert.deepEqual(reenrollment.json().simplifiedEnrollment, {
    mode: 'encrypted-code-bootstrap',
    version: 1,
  });
  assert.match(
    reenrollment.json().enrollmentCode,
    /^\d{4}(?:-\d{4}){3}$/,
  );
  const reenrollmentCodeBootstrap = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enrollment-bootstrap',
    payload: {
      enrollmentCodeId: enrollmentCodeLookupId(
        reenrollment.json().enrollmentCode,
      ),
    },
  });
  assert.equal(
    reenrollmentCodeBootstrap.statusCode,
    200,
    reenrollmentCodeBootstrap.body,
  );
  const resolvedReenrollment = decryptEnrollmentCodeBootstrap({
    payload: reenrollmentCodeBootstrap.json(),
    enrollmentCode: reenrollment.json().enrollmentCode,
  });
  assert.equal(resolvedReenrollment.deviceId, otherPendingDevice.id);
  assert.equal(resolvedReenrollment.enrollmentKey, reenrollment.json().enrollmentKey);
  const reenrollmentTrustBootstrap = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/trust-bootstrap?deviceId=${otherPendingDevice.id}`,
  });
  assert.equal(
    reenrollmentTrustBootstrap.statusCode,
    200,
    reenrollmentTrustBootstrap.body,
  );
  assert.equal(
    decryptTrustBootstrap({
      payload: reenrollmentTrustBootstrap.json(),
      deviceId: otherPendingDevice.id,
      enrollmentKey: reenrollment.json().enrollmentKey,
    }),
    serverCaPem,
  );
  const reenrolledTv = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: otherPendingDevice.id,
      enrollmentKey: reenrollment.json().enrollmentKey,
    },
  });
  assert.equal(reenrolledTv.statusCode, 201, reenrolledTv.body);
  assert.equal(reenrolledTv.json().credentialGeneration, 3);
  const reauthenticated = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${otherPendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': otherPendingDevice.id,
      'x-roomframe-device-key': reenrolledTv.json().deviceKey,
    },
  });
  assert.equal(reauthenticated.statusCode, 200, reauthenticated.body);

  const updateOffer = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/update',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(updateOffer.statusCode, 200, updateOffer.body);
  assert.equal(updateOffer.json().available, true);
  assert.equal(updateOffer.json().artifact.packageName, 'org.roomframe.tv');
  assert.equal(updateOffer.json().installation.silentRequiresDeviceOwner, true);

  const apkDownload = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/updates/${deployment.id}/apk`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(apkDownload.statusCode, 200, apkDownload.body);
  assert.equal(apkDownload.headers['content-type'], 'application/vnd.android.package-archive');
  assert.equal(
    crypto.createHash('sha256').update(apkDownload.rawPayload).digest('hex'),
    updateOffer.json().artifact.sha256,
  );

  for (const status of ['downloaded', 'installing', 'installed']) {
    if (status === 'installed') {
      const falseInstalledReport = await app.inject({
        method: 'POST',
        url: `/api/v1/tv/updates/${deployment.id}/status`,
        headers: {
          'x-roomframe-device-id': pendingDevice.id,
          'x-roomframe-device-key': deviceCredential.deviceKey,
        },
        payload: {
          status,
          version: '9.9.9',
        },
      });
      assert.equal(falseInstalledReport.statusCode, 409, falseInstalledReport.body);
      assert.equal(falseInstalledReport.json().error, 'installed_version_mismatch');
    }
    const report = await app.inject({
      method: 'POST',
      url: `/api/v1/tv/updates/${deployment.id}/status`,
      headers: {
        'x-roomframe-device-id': pendingDevice.id,
        'x-roomframe-device-key': deviceCredential.deviceKey,
      },
      payload: {
        status,
        version: status === 'installed' ? importedRelease.version : '0.3.0',
      },
    });
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().status, status);
  }

  const completedDeployment = await app.inject({
    method: 'POST',
    url: `/api/v1/deployments/${deployment.id}/advance`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { batchSize: 1 },
  });
  assert.equal(completedDeployment.statusCode, 200, completedDeployment.body);
  assert.equal(completedDeployment.json().status, 'completed');

  const retryDeploymentResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/releases/${importedRelease.releaseId}/deployments`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      strategy: 'canary',
      targetType: 'tv',
      targetId: pendingDevice.id,
      batchSize: 1,
    },
  });
  assert.equal(retryDeploymentResponse.statusCode, 201, retryDeploymentResponse.body);
  const retryDeployment = retryDeploymentResponse.json();
  const failedWithoutCode = await app.inject({
    method: 'POST',
    url: `/api/v1/tv/updates/${retryDeployment.id}/status`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: { status: 'failed', version: importedRelease.version },
  });
  assert.equal(failedWithoutCode.statusCode, 400, failedWithoutCode.body);
  assert.equal(failedWithoutCode.json().error, 'update_error_code_required');
  const failedReport = await app.inject({
    method: 'POST',
    url: `/api/v1/tv/updates/${retryDeployment.id}/status`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: {
      status: 'failed',
      version: importedRelease.version,
      errorCode: 'download-failed',
    },
  });
  assert.equal(failedReport.statusCode, 200, failedReport.body);
  assert.equal(failedReport.json().status, 'failed');
  const retriedDeployment = await app.inject({
    method: 'POST',
    url: `/api/v1/deployments/${retryDeployment.id}/retry`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {},
  });
  assert.equal(retriedDeployment.statusCode, 200, retriedDeployment.body);
  assert.equal(retriedDeployment.json().retriedCount, 1);
  assert.equal(retriedDeployment.json().progress.offered, 1);
  const retriedOffer = await app.inject({
    method: 'GET',
    url: '/api/v1/tv/update',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(retriedOffer.statusCode, 200, retriedOffer.body);
  assert.equal(retriedOffer.json().available, true);
  assert.equal(retriedOffer.json().deployment.id, retryDeployment.id);

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

  const acceptedMetrics = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/metrics',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: {
      startupMs: 1240,
      resumeMs: 180,
      memoryBytes: 805_306_368,
      storageFreeBytes: 2_147_483_648,
      networkState: 'ethernet',
      syncRevision: deviceSync.json().revision,
      syncDurationMs: 245,
      updateState: 'available',
      silentUpdateCapable: true,
    },
  });
  assert.equal(acceptedMetrics.statusCode, 202, acceptedMetrics.body);
  const rejectedMetrics = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/metrics',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: { networkState: 'personal-device-name' },
  });
  assert.equal(rejectedMetrics.statusCode, 400, rejectedMetrics.body);
  const rejectedMetricDetail = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/metrics',
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
    payload: {
      networkState: 'wifi',
      errorCode: 'personal-device-name',
    },
  });
  assert.equal(rejectedMetricDetail.statusCode, 400, rejectedMetricDetail.body);
  assert.equal(rejectedMetricDetail.json().error, 'unsupported_metric_error_code');

  const archivedEnrollment = await app.inject({
    method: 'POST',
    url: '/api/v1/tvs/enrollment',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      displayName: 'TV archivée',
      roomName: 'Ancienne salle',
    },
  });
  assert.equal(archivedEnrollment.statusCode, 201, archivedEnrollment.body);
  const archivedClaim = await app.inject({
    method: 'POST',
    url: '/api/v1/tv/enroll',
    payload: {
      deviceId: archivedEnrollment.json().id,
      enrollmentKey: archivedEnrollment.json().enrollmentKey,
    },
  });
  assert.equal(archivedClaim.statusCode, 201, archivedClaim.body);
  const archivedRevocation = await app.inject({
    method: 'POST',
    url: `/api/v1/tvs/${archivedEnrollment.json().id}/revoke`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'REVOQUER LA TV' },
  });
  assert.equal(archivedRevocation.statusCode, 200, archivedRevocation.body);

  const studio = await app.inject({
    method: 'GET',
    url: '/api/v1/studio',
    headers: { cookie },
  });
  assert.equal(studio.statusCode, 200);
  const studioState = studio.json();
  assert.equal(studioState.scene.currentRevision, 1);
  assert.deepEqual(studioState.measuredMetrics, {
    totalScreens: 2,
    onlineScreens: 2,
    reportingScreens: 1,
  });
  const archivedScreen = studioState.tvs.find(
    (screen) => screen.id === archivedEnrollment.json().id,
  );
  assert.equal(archivedScreen.enrollment_state, 'revoked');
  assert.equal(archivedScreen.online, null);
  const measuredScreen = studioState.tvs.find((screen) => screen.id === pendingDevice.id);
  assert.equal(measuredScreen.online, true);
  assert.equal(measuredScreen.latest_metric.networkState, 'ethernet');
  assert.equal(measuredScreen.latest_metric.storageFreeBytes, 2_147_483_648);
  assert.equal(measuredScreen.latest_metric.syncDurationMs, 245);
  const fleet = await app.inject({
    method: 'GET',
    url: '/api/v1/tvs',
    headers: { cookie },
  });
  assert.equal(fleet.statusCode, 200, fleet.body);
  const fleetState = fleet.json();
  assert.deepEqual(fleetState.measuredMetrics, studioState.measuredMetrics);
  const refreshedScreen = fleetState.tvs.find((screen) => screen.id === pendingDevice.id);
  assert.equal(refreshedScreen.online, true);
  assert.equal(refreshedScreen.latest_metric.networkState, 'ethernet');
  assert.equal(refreshedScreen.latest_metric.storageFreeBytes, 2_147_483_648);
  assert.equal(refreshedScreen.latest_metric.syncDurationMs, 245);

  const archivedDeletionWithoutCsrf = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${archivedEnrollment.json().id}`,
    headers: { cookie },
    payload: { confirmation: 'SUPPRIMER LA TV' },
  });
  assert.equal(archivedDeletionWithoutCsrf.statusCode, 403);
  const archivedDeletionWrongPhrase = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${archivedEnrollment.json().id}`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'SUPPRIMER' },
  });
  assert.equal(archivedDeletionWrongPhrase.statusCode, 400);
  assert.equal(
    archivedDeletionWrongPhrase.json().error,
    'tv_deletion_confirmation_required',
  );
  const activeDeletion = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${pendingDevice.id}`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'SUPPRIMER LA TV' },
  });
  assert.equal(activeDeletion.statusCode, 409, activeDeletion.body);
  assert.equal(activeDeletion.json().error, 'tv_must_be_revoked_before_deletion');
  const simulator = studioState.tvs.find(
    (screen) => screen.enrollment_state === 'simulated',
  );
  assert.ok(simulator);
  const simulatorDeletion = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${simulator.id}`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'SUPPRIMER LA TV' },
  });
  assert.equal(simulatorDeletion.statusCode, 409, simulatorDeletion.body);
  assert.equal(simulatorDeletion.json().error, 'simulator_deletion_not_allowed');

  await Promise.all([
    pool.query(
      `INSERT INTO scene_assignments (id, scene_id, target_type, target_id)
       VALUES ($1, $2, 'tv', $3)`,
      [crypto.randomUUID(), studioState.scene.id, archivedEnrollment.json().id],
    ),
    pool.query(
      `INSERT INTO scene_schedules (
         id, scene_id, target_type, target_id, starts_at, ends_at
       ) VALUES ($1, $2, 'tv', $3, now() + interval '1 day', now() + interval '2 days')`,
      [crypto.randomUUID(), studioState.scene.id, archivedEnrollment.json().id],
    ),
    pool.query(
      `INSERT INTO messages (id, title, body, target_type, target_id)
       VALUES ($1, 'Archive', 'À supprimer', 'tv', $2)`,
      [crypto.randomUUID(), archivedEnrollment.json().id],
    ),
    pool.query(
      `INSERT INTO source_settings (
         id, target_type, target_id, source_kind, label, configuration
       ) VALUES ($1, 'tv', $2, 'hdmi', 'Archive', '{}'::jsonb)`,
      [crypto.randomUUID(), archivedEnrollment.json().id],
    ),
    pool.query(
      `INSERT INTO power_schedules (id, target_type, target_id, timezone, rules)
       VALUES ($1, 'tv', $2, 'Europe/Paris', '[]'::jsonb)`,
      [crypto.randomUUID(), archivedEnrollment.json().id],
    ),
    pool.query(
      `INSERT INTO device_metrics (screen_id, payload)
       VALUES ($1, '{}'::jsonb)`,
      [archivedEnrollment.json().id],
    ),
  ]);

  const archivedDeletion = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${archivedEnrollment.json().id}`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'SUPPRIMER LA TV' },
  });
  assert.equal(archivedDeletion.statusCode, 200, archivedDeletion.body);
  assert.deepEqual(archivedDeletion.json(), {
    deleted: true,
    id: archivedEnrollment.json().id,
  });
  const repeatedArchivedDeletion = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tvs/${archivedEnrollment.json().id}`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { confirmation: 'SUPPRIMER LA TV' },
  });
  assert.equal(repeatedArchivedDeletion.statusCode, 404);
  assert.equal(repeatedArchivedDeletion.json().error, 'tv_not_found');

  const fleetAfterDeletion = await app.inject({
    method: 'GET',
    url: '/api/v1/tvs',
    headers: { cookie },
  });
  assert.equal(fleetAfterDeletion.statusCode, 200, fleetAfterDeletion.body);
  assert.equal(
    fleetAfterDeletion.json().tvs.some((screen) => screen.id === archivedEnrollment.json().id),
    false,
  );
  assert.deepEqual(fleetAfterDeletion.json().measuredMetrics, studioState.measuredMetrics);

  const deletedTvReferences = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM scene_assignments WHERE target_type = 'tv' AND target_id = $1) AS scene_assignments,
       (SELECT count(*)::integer FROM scene_schedules WHERE target_type = 'tv' AND target_id = $1) AS scene_schedules,
       (SELECT count(*)::integer FROM messages WHERE target_type = 'tv' AND target_id = $1) AS messages,
       (SELECT count(*)::integer FROM source_settings WHERE target_type = 'tv' AND target_id = $1) AS source_settings,
       (SELECT count(*)::integer FROM power_schedules WHERE target_type = 'tv' AND target_id = $1) AS power_schedules,
       (SELECT count(*)::integer FROM device_metrics WHERE screen_id = $1) AS device_metrics,
       (SELECT count(*)::integer FROM audit_log WHERE action = 'tv.deleted' AND target_id = $1::text) AS audit_entries`,
    [archivedEnrollment.json().id],
  );
  assert.deepEqual(deletedTvReferences.rows[0], {
    scene_assignments: 0,
    scene_schedules: 0,
    messages: 0,
    source_settings: 0,
    power_schedules: 0,
    device_metrics: 0,
    audit_entries: 1,
  });
  const seededGreeting = studioState.scene.document.nodes.find(
    (node) => node.kind === 'text' && node.props?.role === 'greeting',
  );
  assert.equal(seededGreeting.props.text, 'Bonjour,\nbienvenue en salle de réunion 1');

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
  personalizedScene.canvas.background.blur = 18;
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

  const secondaryDocument = structuredClone(personalizedScene);
  secondaryDocument.name = 'Accueil groupe projet';
  const secondaryScene = await app.inject({
    method: 'POST',
    url: '/api/v1/scenes',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      name: secondaryDocument.name,
      scene: secondaryDocument,
    },
  });
  assert.equal(secondaryScene.statusCode, 201, secondaryScene.body);
  const secondarySceneId = secondaryScene.json().id;
  const secondaryStudio = await app.inject({
    method: 'GET',
    url: `/api/v1/studio?sceneId=${secondarySceneId}`,
    headers: { cookie },
  });
  assert.equal(secondaryStudio.statusCode, 200, secondaryStudio.body);
  assert.equal(secondaryStudio.json().scene.id, secondarySceneId);
  assert.equal(secondaryStudio.json().scene.document.layoutId, secondarySceneId);
  assert.equal(secondaryStudio.json().scenes.length, 2);
  assert.equal(secondaryStudio.json().revisions.length, 1);
  const unpublishedAssignment = await app.inject({
    method: 'PUT',
    url: '/api/v1/scene-assignments',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: secondarySceneId,
      targetType: 'group',
      targetId: groupId,
    },
  });
  assert.equal(unpublishedAssignment.statusCode, 409, unpublishedAssignment.body);
  assert.equal(unpublishedAssignment.json().error, 'scene_not_published');
  const unpublishedSchedule = await app.inject({
    method: 'POST',
    url: '/api/v1/scene-schedules',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: secondarySceneId,
      targetType: 'group',
      targetId: groupId,
      startsAt: new Date(Date.now() + 60_000).toISOString(),
      endsAt: new Date(Date.now() + 120_000).toISOString(),
    },
  });
  assert.equal(unpublishedSchedule.statusCode, 409, unpublishedSchedule.body);
  assert.equal(unpublishedSchedule.json().error, 'scene_not_published');
  const secondaryPublication = await app.inject({
    method: 'POST',
    url: `/api/v1/scenes/${secondarySceneId}/publish`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { revision: 1 },
  });
  assert.equal(secondaryPublication.statusCode, 200, secondaryPublication.body);
  const missingTargetAssignment = await app.inject({
    method: 'PUT',
    url: '/api/v1/scene-assignments',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: secondarySceneId,
      targetType: 'group',
      targetId: crypto.randomUUID(),
    },
  });
  assert.equal(missingTargetAssignment.statusCode, 404, missingTargetAssignment.body);
  assert.equal(missingTargetAssignment.json().error, 'group_not_found');
  const groupAssignment = await app.inject({
    method: 'PUT',
    url: '/api/v1/scene-assignments',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: secondarySceneId,
      targetType: 'group',
      targetId: groupId,
    },
  });
  assert.equal(groupAssignment.statusCode, 200, groupAssignment.body);
  assert.equal(groupAssignment.json().assigned, true);
  const assignedGroupPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=group&targetId=${groupId}`,
    headers: { cookie },
  });
  assert.equal(assignedGroupPreview.statusCode, 200, assignedGroupPreview.body);
  assert.equal(assignedGroupPreview.json().scene.id, secondarySceneId);
  await pool.query(
    'UPDATE screens SET group_id = $2, updated_at = now() WHERE id = $1',
    [pendingDevice.id, groupId],
  );
  const assignedGroupSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(assignedGroupSync.statusCode, 200, assignedGroupSync.body);
  assert.equal(assignedGroupSync.json().manifest.sceneId, secondarySceneId);

  const scheduleStart = new Date(Date.now() + 5 * 60_000);
  const scheduleEnd = new Date(Date.now() + 10 * 60_000);
  const scheduledScene = await app.inject({
    method: 'POST',
    url: '/api/v1/scene-schedules',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: studioState.scene.id,
      targetType: 'group',
      targetId: groupId,
      startsAt: scheduleStart.toISOString(),
      endsAt: scheduleEnd.toISOString(),
    },
  });
  assert.equal(scheduledScene.statusCode, 201, scheduledScene.body);
  assert.equal(scheduledScene.json().schedule.status, 'scheduled');
  assert.equal(scheduledScene.json().syncRevision, null);
  const scheduledSceneId = scheduledScene.json().schedule.id;
  const overlappingSchedule = await app.inject({
    method: 'POST',
    url: '/api/v1/scene-schedules',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: studioState.scene.id,
      targetType: 'group',
      targetId: groupId,
      startsAt: new Date(scheduleStart.getTime() + 60_000).toISOString(),
      endsAt: new Date(scheduleEnd.getTime() + 60_000).toISOString(),
    },
  });
  assert.equal(overlappingSchedule.statusCode, 409, overlappingSchedule.body);
  assert.equal(overlappingSchedule.json().error, 'scene_schedule_overlap');
  const forbiddenGroupSchedule = await app.inject({
    method: 'POST',
    url: '/api/v1/scene-schedules',
    headers: { cookie: contentCookie, 'x-csrf-token': contentCsrfToken },
    payload: {
      sceneId: studioState.scene.id,
      targetType: 'group',
      targetId: groupId,
      startsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  });
  assert.equal(forbiddenGroupSchedule.statusCode, 403, forbiddenGroupSchedule.body);
  const revisionBeforeScheduleActivation = await pool.query(
    'SELECT revision FROM sync_state WHERE singleton = true',
  );
  await pool.query(
    `UPDATE scene_schedules
     SET starts_at = now() - interval '1 minute',
         ends_at = now() + interval '1 minute'
     WHERE id = $1`,
    [scheduledSceneId],
  );
  const activation = await processSceneScheduleTransitions(pool);
  assert.deepEqual(
    {
      transitioned: activation.transitioned,
      effectiveChanges: activation.effectiveChanges,
    },
    { transitioned: 1, effectiveChanges: 1 },
  );
  assert.equal(
    activation.syncRevision,
    Number(revisionBeforeScheduleActivation.rows[0].revision) + 1,
  );
  const scheduledGroupPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=group&targetId=${groupId}`,
    headers: { cookie },
  });
  assert.equal(scheduledGroupPreview.statusCode, 200, scheduledGroupPreview.body);
  assert.equal(scheduledGroupPreview.json().scene.id, studioState.scene.id);
  const scheduledDeviceSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}&revision=${assignedGroupSync.json().revision}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(scheduledDeviceSync.statusCode, 200, scheduledDeviceSync.body);
  assert.equal(scheduledDeviceSync.json().upToDate, false);
  assert.equal(scheduledDeviceSync.json().manifest.sceneId, studioState.scene.id);
  await pool.query(
    `UPDATE scene_schedules
     SET ends_at = now() - interval '1 second'
     WHERE id = $1`,
    [scheduledSceneId],
  );
  const completion = await processSceneScheduleTransitions(pool);
  assert.equal(completion.transitioned, 1);
  assert.equal(completion.effectiveChanges, 1);
  assert.equal(completion.syncRevision, activation.syncRevision + 1);
  const restoredGroupPreview = await app.inject({
    method: 'GET',
    url: `/api/v1/studio/preview?targetType=group&targetId=${groupId}`,
    headers: { cookie },
  });
  assert.equal(restoredGroupPreview.statusCode, 200, restoredGroupPreview.body);
  assert.equal(restoredGroupPreview.json().scene.id, secondarySceneId);
  const restoredDeviceSync = await app.inject({
    method: 'GET',
    url: `/api/v1/tv/sync?deviceId=${pendingDevice.id}&revision=${scheduledDeviceSync.json().revision}`,
    headers: {
      'x-roomframe-device-id': pendingDevice.id,
      'x-roomframe-device-key': deviceCredential.deviceKey,
    },
  });
  assert.equal(restoredDeviceSync.statusCode, 200, restoredDeviceSync.body);
  assert.equal(restoredDeviceSync.json().upToDate, false);
  assert.equal(restoredDeviceSync.json().manifest.sceneId, secondarySceneId);

  const activeSceneSchedule = await app.inject({
    method: 'POST',
    url: '/api/v1/scene-schedules',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {
      sceneId: studioState.scene.id,
      targetType: 'group',
      targetId: groupId,
      startsAt: new Date().toISOString(),
      endsAt: null,
    },
  });
  assert.equal(activeSceneSchedule.statusCode, 201, activeSceneSchedule.body);
  assert.equal(activeSceneSchedule.json().schedule.status, 'active');
  assert.ok(Number.isSafeInteger(activeSceneSchedule.json().syncRevision));
  const activeScheduleId = activeSceneSchedule.json().schedule.id;
  const cancelWithoutCsrf = await app.inject({
    method: 'POST',
    url: `/api/v1/scene-schedules/${activeScheduleId}/cancel`,
    headers: { cookie },
    payload: {},
  });
  assert.equal(cancelWithoutCsrf.statusCode, 403, cancelWithoutCsrf.body);
  const cancelledSchedule = await app.inject({
    method: 'POST',
    url: `/api/v1/scene-schedules/${activeScheduleId}/cancel`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {},
  });
  assert.equal(cancelledSchedule.statusCode, 200, cancelledSchedule.body);
  assert.equal(cancelledSchedule.json().schedule.status, 'cancelled');
  assert.ok(Number.isSafeInteger(cancelledSchedule.json().syncRevision));
  const duplicateCancellation = await app.inject({
    method: 'POST',
    url: `/api/v1/scene-schedules/${activeScheduleId}/cancel`,
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: {},
  });
  assert.equal(duplicateCancellation.statusCode, 409, duplicateCancellation.body);
  assert.equal(duplicateCancellation.json().error, 'scene_schedule_not_cancellable');
  const scheduleStudio = await app.inject({
    method: 'GET',
    url: `/api/v1/studio?sceneId=${secondarySceneId}`,
    headers: { cookie },
  });
  assert.equal(scheduleStudio.statusCode, 200, scheduleStudio.body);
  assert.equal(scheduleStudio.json().sceneSchedules.length, 2);
  assert.ok(scheduleStudio.json().sceneSchedules.some(
    (schedule) => schedule.id === scheduledSceneId && schedule.status === 'completed',
  ));
  assert.ok(scheduleStudio.json().sceneSchedules.some(
    (schedule) => schedule.id === activeScheduleId && schedule.status === 'cancelled',
  ));
  const sceneScheduleAudit = await pool.query(
    `SELECT action, count(*)::integer AS count
     FROM audit_log
     WHERE action LIKE 'scene.schedule.%'
     GROUP BY action`,
  );
  const sceneScheduleAuditCounts = Object.fromEntries(
    sceneScheduleAudit.rows.map((row) => [row.action, row.count]),
  );
  assert.equal(sceneScheduleAuditCounts['scene.schedule.created'], 2);
  assert.equal(sceneScheduleAuditCounts['scene.schedule.activated'], 1);
  assert.equal(sceneScheduleAuditCounts['scene.schedule.completed'], 1);
  assert.equal(sceneScheduleAuditCounts['scene.schedule.cancelled'], 1);

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
  assert.equal(sync.json().documents.scene.canvas.background.blur, 18);
  assert.equal(sync.json().documents.branding.displayName, 'Atelier de test');
  assert.equal(sync.json().documents.branding.accent, '#1aa6b7');
  assert.ok(sync.json().manifest.documents.some((entry) => entry.path === 'branding.json'));
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
  assert.equal(statusAfter.json().identity.displayName, 'Atelier de test');
  const locked = await app.inject({
    method: 'POST',
    url: '/api/v1/bootstrap/totp',
    payload: { bootstrapToken, username: 'another-owner' },
  });
  assert.equal(locked.statusCode, 409);

  const migrationPool = createPool({
    ...config.database,
    user: process.env.ROOMFRAME_TEST_DB_MIGRATOR_USER ?? config.database.user,
    password: process.env.ROOMFRAME_TEST_DB_MIGRATOR_PASSWORD ?? config.database.password,
    application_name: 'roomframe-integration-migrate',
  });
  await runMigrations(migrationPool, config.migrationsDir, {
    migrationRole: splitDatabaseRoles ? 'roomframe_owner' : null,
    runtimeRole: splitDatabaseRoles ? 'roomframe_runtime' : null,
  });
  await migrationPool.end();
  const seedsAfterMigrations = await pool.query('SELECT count(*) AS count FROM experience_seed_history');
  assert.equal(seedsAfterMigrations.rows[0].count, '1');
  const updatePolicyAfterMigrations = await pool.query(
    `SELECT mode, minimum_import_age_minutes, timezone
     FROM server_update_policy
     WHERE singleton = true`,
  );
  assert.deepEqual(updatePolicyAfterMigrations.rows[0], {
    mode: 'automatic',
    minimum_import_age_minutes: 15,
    timezone: 'UTC',
  });
  const schedulesAfterMigrations = await pool.query(
    'SELECT status, count(*)::integer AS count FROM scene_schedules GROUP BY status',
  );
  assert.deepEqual(
    Object.fromEntries(schedulesAfterMigrations.rows.map((row) => [row.status, row.count])),
    { cancelled: 1, completed: 1 },
  );
  const credentialsAfterMigrations = await pool.query(
    `SELECT id, enrollment_state, credential_generation,
            device_key_pending, device_key_pending_expires_at
     FROM screens
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[pendingDevice.id, otherPendingDevice.id]],
  );
  const credentialStateById = Object.fromEntries(
    credentialsAfterMigrations.rows.map((row) => [row.id, row]),
  );
  assert.equal(credentialStateById[pendingDevice.id].enrollment_state, 'active');
  assert.equal(credentialStateById[pendingDevice.id].credential_generation, '2');
  assert.equal(credentialStateById[pendingDevice.id].device_key_pending, null);
  assert.equal(credentialStateById[otherPendingDevice.id].enrollment_state, 'active');
  assert.equal(credentialStateById[otherPendingDevice.id].credential_generation, '3');
  assert.equal(credentialStateById[otherPendingDevice.id].device_key_pending, null);
  const credentialAudit = await pool.query(
    `SELECT action, count(*)::integer AS count
     FROM audit_log
     WHERE action IN (
       'tv.credential.rotation.prepared',
       'tv.credential.rotation.confirmed',
       'tv.credential.revoked',
       'tv.reenrollment.created'
     )
     GROUP BY action`,
  );
  assert.deepEqual(
    Object.fromEntries(credentialAudit.rows.map((row) => [row.action, row.count])),
    {
      'tv.credential.revoked': 2,
      'tv.credential.rotation.confirmed': 1,
      'tv.credential.rotation.prepared': 1,
      'tv.reenrollment.created': 1,
    },
  );
  const groupPolicyAfterMigrations = await pool.query(
    `SELECT return_home_when_inactive_minutes, home_sleep_minutes, rules
     FROM power_schedules
     WHERE target_type = 'group' AND target_id = $1`,
    [groupId],
  );
  assert.equal(groupPolicyAfterMigrations.rows[0].return_home_when_inactive_minutes, 12);
  assert.equal(groupPolicyAfterMigrations.rows[0].home_sleep_minutes, 25);
  assert.equal(groupPolicyAfterMigrations.rows[0].rules[0].wake, '07:30');
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
  const passkeysAfterRecovery = await pool.query(
    'SELECT count(*) AS count FROM user_webauthn_credentials',
  );
  assert.equal(passkeysAfterRecovery.rows[0].count, '0');
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
