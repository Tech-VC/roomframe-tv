import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  appendAudit,
  attachSessionCookie,
  clearSessionCookie,
  issueSession,
  requireCsrf,
  requireSession,
} from './auth.mjs';
import { withTransaction } from './database.mjs';
import {
  decryptSecret,
  csrfTokenForSession,
  encryptSecret,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  sha256,
  timingSafeTextEqual,
  verifyPassword,
} from './security.mjs';
import { initializeEmptyInstance, readServerState } from './seed.mjs';
import { buildTotpUri, generateTotpSecret, verifyTotp } from './totp.mjs';

const cleanText = (value, {
  field,
  minimum = 1,
  maximum,
  multiline = false,
}) => {
  const source = String(value ?? '').replace(/\r\n?/gu, '\n');
  const result = multiline
    ? source
      .split('\n')
      .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trim())
      .slice(0, 2)
      .join('\n')
      .trim()
    : source.replace(/\s+/gu, ' ').trim();
  if (result.length < minimum || result.length > maximum) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return result;
};

const color = (value, fallback) => {
  const result = String(value ?? fallback).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(result)) {
    throw Object.assign(new Error('invalid_brand_color'), { statusCode: 400 });
  }
  return result;
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw Object.assign(new Error('invalid_policy_value'), { statusCode: 400 });
  }
  return result;
};

const normalizeBootstrapPayload = (body) => {
  const roomName = cleanText(body.roomName ?? 'Salle de réunion 1', {
    field: 'room_name',
    maximum: 100,
  });
  return {
    displayName: cleanText(body.displayName, { field: 'display_name', maximum: 100 }),
    roomName,
    defaultGreeting: cleanText(
      body.defaultGreeting ?? `Bonjour, bienvenue en ${roomName.toLowerCase()}`,
      { field: 'default_greeting', maximum: 220, multiline: true },
    ),
    branding: {
      primary: color(body.branding?.primary, '#151511'),
      accent: color(body.branding?.accent, '#ff4f1f'),
      surface: color(body.branding?.surface, '#e7e4da'),
      ink: color(body.branding?.ink, '#11130f'),
      muted: color(body.branding?.muted, '#62645d'),
      fontPreset: ['studio', 'compact', 'humanist'].includes(body.branding?.fontPreset)
        ? body.branding.fontPreset
        : 'studio',
    },
    policies: {
      returnHomeWhenInactiveMinutes: boundedInteger(
        body.policies?.returnHomeWhenInactiveMinutes,
        15,
        1,
        1440,
      ),
      homeSleepMinutes: boundedInteger(body.policies?.homeSleepMinutes, 30, 1, 1440),
      powerScheduleEnabled: Boolean(body.policies?.powerScheduleEnabled ?? false),
    },
    admin: {
      username: normalizeUsername(body.bootstrapAdmin?.username),
      email: normalizeEmail(body.bootstrapAdmin?.email),
      password: body.bootstrapAdmin?.password,
    },
  };
};

const configured = async (pool) => {
  const result = await pool.query('SELECT EXISTS (SELECT 1 FROM roomframe_instance WHERE singleton = true) AS value');
  return Boolean(result.rows[0]?.value);
};

const assertAuthorityToken = (supplied, expected) => {
  if (
    typeof supplied !== 'string'
    || supplied.length < 20
    || !timingSafeTextEqual(sha256(supplied), sha256(expected))
  ) {
    throw Object.assign(new Error('invalid_bootstrap_token'), { statusCode: 403 });
  }
  return sha256(supplied);
};

const createTotpChallenge = async ({
  pool,
  config,
  authorityTokenHash,
  username,
  purpose,
}) => {
  const secret = generateTotpSecret();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query(
    `INSERT INTO bootstrap_challenges (
       id, purpose, subject, authority_token_hash, totp_secret_encrypted, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      purpose,
      username,
      authorityTokenHash,
      JSON.stringify(encryptSecret(secret, config.totpEncryptionKey)),
      expiresAt,
    ],
  );
  return {
    challengeId: id,
    secret,
    otpauthUrl: buildTotpUri({ secret, username }),
    expiresAt: expiresAt.toISOString(),
  };
};

const readRecoveryRequest = async (config, suppliedToken) => {
  let request;
  try {
    request = JSON.parse(await readFile(config.recoveryRequestFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error('recovery_not_requested'), { statusCode: 404 });
    }
    throw error;
  }
  const expiresAt = Date.parse(request?.expiresAt);
  if (
    !request
    || typeof request !== 'object'
    || !/^[a-f0-9]{64}$/.test(String(request.tokenHash ?? ''))
    || !Number.isFinite(expiresAt)
    || request.consumedAt
    || expiresAt <= Date.now()
    || !timingSafeTextEqual(String(request.tokenHash), sha256(String(suppliedToken ?? '')))
  ) {
    throw Object.assign(new Error('invalid_recovery_token'), { statusCode: 403 });
  }
  return request;
};

export const registerBootstrapAuthRoutes = ({
  app,
  pool,
  config,
  validators,
  experience,
}) => {
  const authenticated = requireSession(pool, config);
  const csrf = requireCsrf(config);
  const dummyPasswordHash = hashPassword(
    `${crypto.randomBytes(32).toString('base64url')}Aa1!`,
  );

  app.get('/api/v1/bootstrap/status', async () => {
    const result = await pool.query(
      'SELECT display_name, config FROM roomframe_instance WHERE singleton = true',
    );
    const instance = result.rows[0];
    const branding = instance?.config?.branding ?? {};
    return {
      serverReady: true,
      configured: Boolean(instance),
      networkManagedExternally: true,
      server: await readServerState(config),
      identity: instance ? {
        displayName: instance.display_name,
        branding: {
          primary: color(branding.primary, '#151511'),
          accent: color(branding.accent, '#ff4f1f'),
          surface: color(branding.surface, '#e7e4da'),
          ink: color(branding.ink, '#11130f'),
          muted: color(branding.muted, '#62645d'),
          fontPreset: ['studio', 'compact', 'humanist'].includes(branding.fontPreset)
            ? branding.fontPreset
            : 'studio',
        },
      } : null,
      defaultExperience: {
        bundleId: experience.manifest.bundleId,
        version: experience.manifest.version,
        verified: true,
      },
    };
  });

  app.post('/api/v1/bootstrap/totp', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    if (await configured(pool)) return reply.code(409).send({ error: 'already_configured' });
    const authorityTokenHash = assertAuthorityToken(
      request.body?.bootstrapToken,
      config.bootstrapToken,
    );
    const username = normalizeUsername(request.body?.username);
    const challenge = await createTotpChallenge({
      pool,
      config,
      authorityTokenHash,
      username,
      purpose: 'bootstrap',
    });
    return reply.code(201).send(challenge);
  });

  app.post('/api/v1/bootstrap/complete', {
    config: { rateLimit: { max: 5, timeWindow: '30 minutes' } },
  }, async (request, reply) => {
    const authorityTokenHash = assertAuthorityToken(
      request.body?.bootstrapToken,
      config.bootstrapToken,
    );
    const payload = normalizeBootstrapPayload(request.body ?? {});
    const passwordHash = await hashPassword(payload.admin.password);
    const server = await readServerState(config);
    const result = await withTransaction(pool, async (client) => {
      const challengeResult = await client.query(
        `SELECT * FROM bootstrap_challenges
         WHERE id = $1 AND purpose = 'bootstrap'
         FOR UPDATE`,
        [request.body?.challengeId],
      );
      const challenge = challengeResult.rows[0];
      if (
        !challenge
        || challenge.used_at
        || challenge.expires_at <= new Date()
        || challenge.subject !== payload.admin.username
        || !timingSafeTextEqual(challenge.authority_token_hash, authorityTokenHash)
      ) {
        throw Object.assign(new Error('invalid_bootstrap_challenge'), { statusCode: 403 });
      }
      const totpSecret = decryptSecret(challenge.totp_secret_encrypted, config.totpEncryptionKey);
      const totpCounter = verifyTotp(totpSecret, request.body?.totpCode);
      if (totpCounter === null) {
        throw Object.assign(new Error('invalid_totp_code'), { statusCode: 403 });
      }
      const user = {
        id: crypto.randomUUID(),
        username: payload.admin.username,
        email: payload.admin.email,
      };
      await client.query(
        `INSERT INTO users (
           id, username, email, password_hash, role_id, totp_secret_encrypted,
           last_totp_counter, webauthn_user_id
         ) VALUES (
           $1, $2, $3, $4,
           (SELECT id FROM roles WHERE slug = 'owner'),
           $5, $6, $7
         )`,
        [
          user.id,
          user.username,
          user.email,
          passwordHash,
          JSON.stringify(encryptSecret(totpSecret, config.totpEncryptionKey)),
          totpCounter,
          Buffer.from(user.id.replaceAll('-', ''), 'hex'),
        ],
      );
      const initialized = await initializeEmptyInstance({
        client,
        payload,
        user,
        server,
        experience,
      });
      validators.assertInstance(initialized.instance);
      await client.query('UPDATE bootstrap_challenges SET used_at = now() WHERE id = $1', [challenge.id]);
      await appendAudit(client, {
        session: { user_id: user.id },
        action: 'bootstrap.completed',
        targetType: 'instance',
        targetId: initialized.instance.instanceId,
        remoteAddress: request.ip,
      });
      const session = await issueSession({ client, config, user, request });
      return { user, initialized, session };
    });
    attachSessionCookie(reply, result.session);
    return reply.code(201).send({
      configured: true,
      instanceId: result.initialized.instance.instanceId,
      sceneId: result.initialized.sceneId,
      user: { ...result.user, role: 'owner' },
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
    });
  });

  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    let username;
    try {
      username = normalizeUsername(request.body?.username);
    } catch {
      throw Object.assign(new Error('invalid_credentials'), { statusCode: 401 });
    }
    const found = await pool.query(
      `SELECT u.*, r.slug AS role, r.permissions
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.username = $1 AND u.active = true`,
      [username],
    );
    const user = found.rows[0];
    const passwordValid = await verifyPassword(
      user?.password_hash ?? await dummyPasswordHash,
      request.body?.password,
    );
    if (!user || !passwordValid) {
      throw Object.assign(new Error('invalid_credentials'), { statusCode: 401 });
    }
    const totpSecret = decryptSecret(user.totp_secret_encrypted, config.totpEncryptionKey);
    const counter = verifyTotp(totpSecret, request.body?.totpCode, {
      lastCounter: user.last_totp_counter,
    });
    if (counter === null) {
      throw Object.assign(new Error('invalid_credentials'), { statusCode: 401 });
    }
    const response = await withTransaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE users SET last_totp_counter = $2, updated_at = now()
         WHERE id = $1 AND (last_totp_counter IS NULL OR last_totp_counter < $2)
         RETURNING id, username, email`,
        [user.id, counter],
      );
      if (updated.rowCount !== 1) {
        throw Object.assign(new Error('invalid_credentials'), { statusCode: 401 });
      }
      const session = await issueSession({
        client,
        config,
        user: updated.rows[0],
        request,
      });
      await appendAudit(client, {
        session: { user_id: user.id },
        action: 'auth.login',
        targetType: 'session',
        targetId: session.sessionId,
        remoteAddress: request.ip,
      });
      return session;
    });
    attachSessionCookie(reply, response);
    return {
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
      csrfToken: response.csrfToken,
      expiresAt: response.expiresAt,
    };
  });

  app.get('/api/v1/auth/session', { preHandler: [authenticated] }, async (request) => {
    const csrfToken = csrfTokenForSession(
      request.roomframeSession.session_id,
      config.sessionSecret,
    );
    return {
      user: {
        id: request.roomframeSession.user_id,
        username: request.roomframeSession.username,
        email: request.roomframeSession.email,
        role: request.roomframeSession.role,
        permissions: request.roomframeSession.permissions,
      },
      csrfToken,
      expiresAt: request.roomframeSession.expires_at,
    };
  });

  app.post('/api/v1/auth/logout', {
    preHandler: [authenticated, csrf],
  }, async (request, reply) => {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [
      request.roomframeSession.session_id,
    ]);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/recovery/totp', {
    config: { rateLimit: { max: 4, timeWindow: '30 minutes' } },
  }, async (request, reply) => {
    const recovery = await readRecoveryRequest(config, request.body?.recoveryToken);
    const username = normalizeUsername(request.body?.username);
    const challenge = await withTransaction(pool, async (client) => {
      await client.query(
        `DELETE FROM recovery_authorities
         WHERE expires_at < now() - interval '7 days'`,
      );
      await client.query(
        `INSERT INTO recovery_authorities (token_hash, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (token_hash) DO NOTHING`,
        [recovery.tokenHash, recovery.expiresAt],
      );
      const authority = await client.query(
        `SELECT token_hash
         FROM recovery_authorities
         WHERE token_hash = $1
           AND consumed_at IS NULL
           AND expires_at > now()
         FOR UPDATE`,
        [recovery.tokenHash],
      );
      if (!authority.rows[0]) {
        throw Object.assign(new Error('invalid_recovery_token'), { statusCode: 403 });
      }
      return createTotpChallenge({
        pool: client,
        config,
        authorityTokenHash: recovery.tokenHash,
        username,
        purpose: 'recovery',
      });
    });
    return reply.code(201).send(challenge);
  });

  app.post('/api/v1/auth/recovery/complete', {
    config: { rateLimit: { max: 4, timeWindow: '30 minutes' } },
  }, async (request) => {
    const recovery = await readRecoveryRequest(config, request.body?.recoveryToken);
    const username = normalizeUsername(request.body?.username);
    const passwordHash = await hashPassword(request.body?.password);
    await withTransaction(pool, async (client) => {
      const authority = await client.query(
        `SELECT token_hash
         FROM recovery_authorities
         WHERE token_hash = $1
           AND consumed_at IS NULL
           AND expires_at > now()
         FOR UPDATE`,
        [recovery.tokenHash],
      );
      if (!authority.rows[0]) {
        throw Object.assign(new Error('invalid_recovery_token'), { statusCode: 403 });
      }
      const challengeResult = await client.query(
        `SELECT * FROM bootstrap_challenges
         WHERE id = $1 AND purpose = 'recovery'
         FOR UPDATE`,
        [request.body?.challengeId],
      );
      const challenge = challengeResult.rows[0];
      if (
        !challenge
        || challenge.used_at
        || challenge.expires_at <= new Date()
        || challenge.subject !== username
        || !timingSafeTextEqual(challenge.authority_token_hash, recovery.tokenHash)
      ) {
        throw Object.assign(new Error('invalid_recovery_challenge'), { statusCode: 403 });
      }
      const secret = decryptSecret(challenge.totp_secret_encrypted, config.totpEncryptionKey);
      const counter = verifyTotp(secret, request.body?.totpCode);
      if (counter === null) throw Object.assign(new Error('invalid_totp_code'), { statusCode: 403 });
      const updated = await client.query(
        `UPDATE users
         SET password_hash = $2, totp_secret_encrypted = $3, last_totp_counter = $4,
             password_changed_at = now(), updated_at = now()
         WHERE username = $1 AND active = true
         RETURNING id`,
        [
          username,
          passwordHash,
          JSON.stringify(encryptSecret(secret, config.totpEncryptionKey)),
          counter,
        ],
      );
      if (updated.rowCount !== 1) {
        throw Object.assign(new Error('recovery_user_not_found'), { statusCode: 404 });
      }
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [
        updated.rows[0].id,
      ]);
      const revokedPasskeys = await client.query(
        'DELETE FROM user_webauthn_credentials WHERE user_id = $1',
        [updated.rows[0].id],
      );
      await client.query(
        'DELETE FROM webauthn_challenges WHERE user_id = $1',
        [updated.rows[0].id],
      );
      await client.query(
        `UPDATE bootstrap_challenges
         SET used_at = now()
         WHERE purpose = 'recovery' AND authority_token_hash = $1`,
        [recovery.tokenHash],
      );
      await client.query(
        'UPDATE recovery_authorities SET consumed_at = now() WHERE token_hash = $1',
        [recovery.tokenHash],
      );
      await appendAudit(client, {
        actorType: 'local-recovery',
        action: 'auth.recovered',
        targetType: 'user',
        targetId: updated.rows[0].id,
        remoteAddress: request.ip,
        details: { revokedPasskeys: revokedPasskeys.rowCount },
      });
    });
    return { recovered: true };
  });
};
