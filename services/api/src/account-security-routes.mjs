import crypto from 'node:crypto';
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
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from './security.mjs';
import { verifyTotp } from './totp.mjs';
import {
  PASSKEY_CHALLENGE_MINUTES,
  assertPasskeyOrigin,
  authenticationOptions,
  credentialIdBuffer,
  normalizedPasskeyLabel,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  webauthnContext,
} from './webauthn.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const routeError = (code, statusCode) => Object.assign(
  new Error(code),
  { statusCode },
);

const validUuid = (value, code = 'invalid_identifier') => {
  const result = String(value ?? '');
  if (!uuidPattern.test(result)) throw routeError(code, 400);
  return result;
};

const challengeExpiry = () => new Date(
  Date.now() + PASSKEY_CHALLENGE_MINUTES * 60 * 1000,
);

const clearOldChallenges = async (client, userId, purpose) => {
  await client.query(
    `DELETE FROM webauthn_challenges
     WHERE expires_at < now() - interval '7 days'
        OR used_at < now() - interval '7 days'`,
  );
  await client.query(
    `DELETE FROM webauthn_challenges
     WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
};

export const stepUpUser = async ({
  client,
  config,
  userId,
  password,
  totpCode,
}) => {
  const result = await client.query(
    `SELECT id, username, email, password_hash, totp_secret_encrypted,
            last_totp_counter, webauthn_user_id
     FROM users
     WHERE id = $1 AND active = true
     FOR UPDATE`,
    [userId],
  );
  const user = result.rows[0];
  if (!user || !await verifyPassword(user.password_hash, password)) {
    throw routeError('step_up_failed', 403);
  }
  const secret = decryptSecret(
    user.totp_secret_encrypted,
    config.totpEncryptionKey,
  );
  const counter = verifyTotp(secret, totpCode, {
    lastCounter: user.last_totp_counter,
  });
  if (counter === null) throw routeError('step_up_failed', 403);
  const updated = await client.query(
    `UPDATE users
     SET last_totp_counter = $2, updated_at = now()
     WHERE id = $1
       AND (last_totp_counter IS NULL OR last_totp_counter < $2)`,
    [user.id, counter],
  );
  if (updated.rowCount !== 1) throw routeError('step_up_failed', 403);
  return user;
};

const serializePasskey = (row) => ({
  id: row.id,
  label: row.label,
  deviceType: row.device_type,
  backedUp: row.backed_up,
  transports: row.transports,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const serializeSession = (row, currentSessionId) => ({
  id: row.id,
  current: row.id === currentSessionId,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  remoteAddress: row.remote_address,
  userAgent: row.user_agent,
});

export const registerAccountSecurityRoutes = ({
  app,
  pool,
  config,
}) => {
  const authenticated = requireSession(pool, config);
  const csrf = requireCsrf(config);
  const dummyPasswordHash = hashPassword(
    `${crypto.randomBytes(32).toString('base64url')}Aa1!`,
  );

  app.get('/api/v1/auth/passkeys', {
    preHandler: [authenticated],
  }, async (request) => {
    const result = await pool.query(
      `SELECT id, label, device_type, backed_up, transports, created_at,
              last_used_at
       FROM user_webauthn_credentials
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [request.roomframeSession.user_id],
    );
    return {
      supported: true,
      canonicalUrl: webauthnContext(config).origin,
      passkeys: result.rows.map(serializePasskey),
    };
  });

  app.post('/api/v1/auth/passkeys/registration/options', {
    config: { rateLimit: { max: 6, timeWindow: '15 minutes' } },
    preHandler: [authenticated, csrf],
  }, async (request, reply) => {
    const context = webauthnContext(config);
    assertPasskeyOrigin(request, context);
    const label = normalizedPasskeyLabel(request.body?.label);
    const result = await withTransaction(pool, async (client) => {
      const user = await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: request.body?.password,
        totpCode: request.body?.totpCode,
      });
      const [credentialResult, instanceResult] = await Promise.all([
        client.query(
          `SELECT credential_id, transports
           FROM user_webauthn_credentials
           WHERE user_id = $1`,
          [user.id],
        ),
        client.query(
          `SELECT display_name
           FROM roomframe_instance
           WHERE singleton = true`,
        ),
      ]);
      const options = await registrationOptions({
        context,
        rpName: instanceResult.rows[0]?.display_name ?? 'RoomFrame',
        user,
        credentials: credentialResult.rows,
      });
      const id = crypto.randomUUID();
      const expiresAt = challengeExpiry();
      await clearOldChallenges(client, user.id, 'registration');
      await client.query(
        `INSERT INTO webauthn_challenges (
           id, user_id, session_id, purpose, challenge, expected_origin,
           rp_id, expires_at
         ) VALUES ($1, $2, $3, 'registration', $4, $5, $6, $7)`,
        [
          id,
          user.id,
          request.roomframeSession.session_id,
          options.challenge,
          context.origin,
          context.rpID,
          expiresAt,
        ],
      );
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'auth.passkey.registration_started',
        targetType: 'user',
        targetId: user.id,
        remoteAddress: request.ip,
      });
      return { id, options, expiresAt };
    });
    return reply.code(201).send({
      challengeId: result.id,
      label,
      options: result.options,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.post('/api/v1/auth/passkeys/registration/complete', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
    preHandler: [authenticated, csrf],
  }, async (request, reply) => {
    const context = webauthnContext(config);
    assertPasskeyOrigin(request, context);
    const challengeId = validUuid(
      request.body?.challengeId,
      'invalid_passkey_challenge',
    );
    const label = normalizedPasskeyLabel(request.body?.label);
    const response = request.body?.response;
    credentialIdBuffer(response?.id);
    const passkey = await withTransaction(pool, async (client) => {
      const challengeResult = await client.query(
        `SELECT *
         FROM webauthn_challenges
         WHERE id = $1
           AND user_id = $2
           AND session_id = $3
           AND purpose = 'registration'
         FOR UPDATE`,
        [
          challengeId,
          request.roomframeSession.user_id,
          request.roomframeSession.session_id,
        ],
      );
      const challenge = challengeResult.rows[0];
      if (
        !challenge
        || challenge.used_at
        || challenge.expires_at <= new Date()
        || challenge.expected_origin !== context.origin
        || challenge.rp_id !== context.rpID
      ) {
        throw routeError('invalid_passkey_challenge', 403);
      }
      const verification = await verifyRegistration({ response, challenge });
      if (!verification.verified || !verification.registrationInfo) {
        throw routeError('invalid_passkey_response', 400);
      }
      const {
        credential,
        credentialBackedUp,
        credentialDeviceType,
      } = verification.registrationInfo;
      const id = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO user_webauthn_credentials (
           id, user_id, credential_id, public_key, sign_count, transports,
           label, device_type, backed_up
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, label, device_type, backed_up, transports, created_at,
                   last_used_at`,
        [
          id,
          request.roomframeSession.user_id,
          credentialIdBuffer(credential.id),
          Buffer.from(credential.publicKey),
          credential.counter,
          credential.transports ?? [],
          label,
          credentialDeviceType,
          credentialBackedUp,
        ],
      );
      await client.query(
        'UPDATE webauthn_challenges SET used_at = now() WHERE id = $1',
        [challenge.id],
      );
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'auth.passkey.registered',
        targetType: 'passkey',
        targetId: id,
        remoteAddress: request.ip,
        details: {
          label,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      });
      return serializePasskey(inserted.rows[0]);
    });
    return reply.code(201).send({ passkey });
  });

  app.post('/api/v1/auth/passkeys/:passkeyId/revoke', {
    config: { rateLimit: { max: 6, timeWindow: '15 minutes' } },
    preHandler: [authenticated, csrf],
  }, async (request) => {
    const passkeyId = validUuid(
      request.params.passkeyId,
      'invalid_passkey_identifier',
    );
    await withTransaction(pool, async (client) => {
      await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: request.body?.password,
        totpCode: request.body?.totpCode,
      });
      const removed = await client.query(
        `DELETE FROM user_webauthn_credentials
         WHERE id = $1 AND user_id = $2
         RETURNING label`,
        [passkeyId, request.roomframeSession.user_id],
      );
      if (removed.rowCount !== 1) {
        throw routeError('passkey_not_found', 404);
      }
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'auth.passkey.revoked',
        targetType: 'passkey',
        targetId: passkeyId,
        remoteAddress: request.ip,
        details: { label: removed.rows[0].label },
      });
    });
    return { revoked: true };
  });

  app.post('/api/v1/auth/passkey/options', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const context = webauthnContext(config);
    assertPasskeyOrigin(request, context);
    let username;
    try {
      username = normalizeUsername(request.body?.username);
    } catch {
      throw routeError('invalid_credentials', 401);
    }
    const result = await withTransaction(pool, async (client) => {
      const found = await client.query(
        `SELECT id, username, email, password_hash
         FROM users
         WHERE username = $1 AND active = true
         FOR UPDATE`,
        [username],
      );
      const user = found.rows[0];
      const passwordValid = await verifyPassword(
        user?.password_hash ?? await dummyPasswordHash,
        request.body?.password,
      );
      if (!user || !passwordValid) {
        throw routeError('invalid_credentials', 401);
      }
      const credentials = await client.query(
        `SELECT credential_id, transports
         FROM user_webauthn_credentials
         WHERE user_id = $1`,
        [user.id],
      );
      if (credentials.rowCount === 0) {
        throw routeError('passkey_not_available', 409);
      }
      const options = await authenticationOptions({
        context,
        credentials: credentials.rows,
      });
      const id = crypto.randomUUID();
      const expiresAt = challengeExpiry();
      await clearOldChallenges(client, user.id, 'authentication');
      await client.query(
        `INSERT INTO webauthn_challenges (
           id, user_id, purpose, challenge, expected_origin, rp_id, expires_at
         ) VALUES ($1, $2, 'authentication', $3, $4, $5, $6)`,
        [
          id,
          user.id,
          options.challenge,
          context.origin,
          context.rpID,
          expiresAt,
        ],
      );
      await appendAudit(client, {
        session: { user_id: user.id },
        action: 'auth.passkey.challenge_created',
        targetType: 'user',
        targetId: user.id,
        remoteAddress: request.ip,
      });
      return { id, options, expiresAt };
    });
    return reply.code(201).send({
      challengeId: result.id,
      options: result.options,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.post('/api/v1/auth/passkey/complete', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const context = webauthnContext(config);
    assertPasskeyOrigin(request, context);
    const challengeId = validUuid(
      request.body?.challengeId,
      'invalid_passkey_challenge',
    );
    const response = request.body?.response;
    const credentialId = credentialIdBuffer(response?.id);
    const result = await withTransaction(pool, async (client) => {
      const challengeResult = await client.query(
        `SELECT c.*, u.username, u.email, r.slug AS role
         FROM webauthn_challenges c
         JOIN users u ON u.id = c.user_id AND u.active = true
         JOIN roles r ON r.id = u.role_id
         WHERE c.id = $1 AND c.purpose = 'authentication'
         FOR UPDATE OF c`,
        [challengeId],
      );
      const challenge = challengeResult.rows[0];
      if (
        !challenge
        || challenge.used_at
        || challenge.expires_at <= new Date()
        || challenge.expected_origin !== context.origin
        || challenge.rp_id !== context.rpID
      ) {
        throw routeError('invalid_passkey_challenge', 403);
      }
      const credentialResult = await client.query(
        `SELECT *
         FROM user_webauthn_credentials
         WHERE user_id = $1 AND credential_id = $2
         FOR UPDATE`,
        [challenge.user_id, credentialId],
      );
      const credential = credentialResult.rows[0];
      if (!credential) throw routeError('invalid_passkey_response', 400);
      const verification = await verifyAuthentication({
        response,
        challenge,
        credential,
      });
      if (!verification.verified || !verification.authenticationInfo) {
        throw routeError('invalid_passkey_response', 400);
      }
      await client.query(
        `UPDATE user_webauthn_credentials
         SET sign_count = $2, last_used_at = now(), updated_at = now()
         WHERE id = $1`,
        [credential.id, verification.authenticationInfo.newCounter],
      );
      await client.query(
        'UPDATE webauthn_challenges SET used_at = now() WHERE id = $1',
        [challenge.id],
      );
      const user = {
        id: challenge.user_id,
        username: challenge.username,
        email: challenge.email,
        role: challenge.role,
      };
      const session = await issueSession({
        client,
        config,
        user,
        request,
      });
      await appendAudit(client, {
        session: { user_id: user.id },
        action: 'auth.login.passkey',
        targetType: 'session',
        targetId: session.sessionId,
        remoteAddress: request.ip,
        details: { passkeyId: credential.id },
      });
      return { user, session };
    });
    attachSessionCookie(reply, result.session);
    return {
      user: result.user,
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
    };
  });

  app.get('/api/v1/auth/sessions', {
    preHandler: [authenticated],
  }, async (request) => {
    const result = await pool.query(
      `SELECT id, created_at, last_seen_at, expires_at, remote_address,
              user_agent
       FROM sessions
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 50`,
      [request.roomframeSession.user_id],
    );
    return {
      sessions: result.rows.map((row) => serializeSession(
        row,
        request.roomframeSession.session_id,
      )),
    };
  });

  app.post('/api/v1/auth/sessions/revoke-others', {
    preHandler: [authenticated, csrf],
  }, async (request) => {
    const revoked = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE sessions
         SET revoked_at = now()
         WHERE user_id = $1
           AND id <> $2
           AND revoked_at IS NULL
           AND expires_at > now()`,
        [
          request.roomframeSession.user_id,
          request.roomframeSession.session_id,
        ],
      );
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'auth.sessions.revoked_others',
        targetType: 'user',
        targetId: request.roomframeSession.user_id,
        remoteAddress: request.ip,
        details: { revokedCount: result.rowCount },
      });
      return result.rowCount;
    });
    return { revoked };
  });

  app.post('/api/v1/auth/sessions/:sessionId/revoke', {
    preHandler: [authenticated, csrf],
  }, async (request, reply) => {
    const sessionId = validUuid(
      request.params.sessionId,
      'invalid_session_identifier',
    );
    const current = sessionId === request.roomframeSession.session_id;
    await withTransaction(pool, async (client) => {
      const revoked = await client.query(
        `UPDATE sessions
         SET revoked_at = now()
         WHERE id = $1
           AND user_id = $2
           AND revoked_at IS NULL
         RETURNING id`,
        [sessionId, request.roomframeSession.user_id],
      );
      if (revoked.rowCount !== 1) throw routeError('session_not_found', 404);
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'auth.session.revoked',
        targetType: 'session',
        targetId: sessionId,
        remoteAddress: request.ip,
        details: { current },
      });
    });
    if (current) clearSessionCookie(reply);
    return { revoked: true, current };
  });
};
