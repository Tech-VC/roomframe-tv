import crypto from 'node:crypto';
import {
  appendAudit,
  attachSessionCookie,
  issueSession,
  requireCsrf,
  requirePermission,
  requireSession,
} from './auth.mjs';
import { stepUpUser } from './account-security-routes.mjs';
import { withTransaction } from './database.mjs';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  randomToken,
  sha256,
  timingSafeTextEqual,
} from './security.mjs';
import {
  buildTotpUri,
  generateTotpSecret,
  verifyTotp,
} from './totp.mjs';

const INVITATION_HOURS = 24;
const ACTIVATION_MINUTES = 15;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{40,128}$/;

const routeError = (code, statusCode) => Object.assign(
  new Error(code),
  { statusCode },
);

const validUuid = (value) => {
  const id = String(value ?? '');
  if (!uuidPattern.test(id)) throw routeError('invalid_user_identifier', 400);
  return id;
};

const activationTokenHash = (value) => {
  const token = String(value ?? '');
  if (!tokenPattern.test(token)) throw routeError('invalid_activation_token', 403);
  return sha256(token);
};

const serializeUser = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email,
  active: row.active,
  status: row.status ?? (row.active ? 'active' : 'disabled'),
  role: row.role,
  roleName: row.role_name,
  sessionCount: Number(row.session_count ?? 0),
  passkeyCount: Number(row.passkey_count ?? 0),
  invitationExpiresAt: row.invitation_expires_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readRole = async (client, slug) => {
  const result = await client.query(
    `SELECT id, slug, display_name, permissions
     FROM roles
     WHERE slug = $1`,
    [slug],
  );
  const role = result.rows[0];
  if (!role) throw routeError('invalid_role', 400);
  return role;
};

const readTargetForUpdate = async (client, userId) => {
  const result = await client.query(
    `SELECT u.id, u.username, u.email, u.active, u.role_id,
            r.slug AS role, r.display_name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
     FOR UPDATE OF u`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) throw routeError('user_not_found', 404);
  return user;
};

const assertDifferentUser = (target, actorId) => {
  if (target.id === actorId) throw routeError('self_management_forbidden', 409);
};

const assertConfirmation = (target, supplied) => {
  let confirmation;
  try {
    confirmation = normalizeUsername(supplied);
  } catch {
    throw routeError('user_confirmation_failed', 409);
  }
  if (!timingSafeTextEqual(confirmation, target.username)) {
    throw routeError('user_confirmation_failed', 409);
  }
};

const assertOwnerCanBeRemoved = async (client, target) => {
  if (target.role !== 'owner' || !target.active) return;
  const result = await client.query(
    `SELECT count(*) AS count
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.active = true AND r.slug = 'owner'`,
  );
  if (Number(result.rows[0].count) <= 1) {
    throw routeError('last_owner_required', 409);
  }
};

const lockOwnerInvariant = async (client) => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('roomframe-active-owner', 0))",
  );
};

const revokeUserAccess = async (client, userId, {
  revokeInvitations = true,
} = {}) => {
  const sessions = await client.query(
    `UPDATE sessions
     SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  const passkeys = await client.query(
    'DELETE FROM user_webauthn_credentials WHERE user_id = $1',
    [userId],
  );
  await client.query(
    'DELETE FROM webauthn_challenges WHERE user_id = $1',
    [userId],
  );
  let invitations = { rowCount: 0 };
  if (revokeInvitations) {
    invitations = await client.query(
      `UPDATE user_invitations
       SET revoked_at = now()
       WHERE user_id = $1
         AND used_at IS NULL
         AND revoked_at IS NULL`,
      [userId],
    );
  }
  return {
    revokedSessions: sessions.rowCount,
    revokedPasskeys: passkeys.rowCount,
    revokedInvitations: invitations.rowCount,
  };
};

const createInvitation = async (client, {
  userId,
  createdBy,
  token,
}) => {
  await client.query(
    `UPDATE user_invitations
     SET revoked_at = now()
     WHERE user_id = $1
       AND used_at IS NULL
       AND revoked_at IS NULL`,
    [userId],
  );
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_HOURS * 60 * 60 * 1000);
  await client.query(
    `INSERT INTO user_invitations (
       id, user_id, token_hash, expires_at, created_by
     ) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, sha256(token), expiresAt, createdBy],
  );
  return { id, expiresAt };
};

const validateOperation = (validators, operation, body = {}) => {
  const payload = { operation, ...body };
  validators.assertAdminUser(payload);
  return payload;
};

export const registerUserRoutes = ({
  app,
  pool,
  config,
  validators,
}) => {
  const authenticated = requireSession(pool, config);
  const csrf = requireCsrf(config);
  const canReadUsers = requirePermission('users:read');
  const ownerWrite = requirePermission('users:owner');

  app.get('/api/v1/users', {
    preHandler: [authenticated, canReadUsers],
  }, async () => {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.active, u.created_at, u.updated_at,
              r.slug AS role, r.display_name AS role_name,
              CASE
                WHEN u.active THEN 'active'
                WHEN invitation.id IS NOT NULL THEN 'pending'
                ELSE 'disabled'
              END AS status,
              invitation.expires_at AS invitation_expires_at,
              (
                SELECT count(*)
                FROM sessions session
                WHERE session.user_id = u.id
                  AND session.revoked_at IS NULL
                  AND session.expires_at > now()
              ) AS session_count,
              (
                SELECT count(*)
                FROM user_webauthn_credentials credential
                WHERE credential.user_id = u.id
              ) AS passkey_count
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN LATERAL (
         SELECT invitation.id, invitation.expires_at
         FROM user_invitations invitation
         WHERE invitation.user_id = u.id
           AND invitation.used_at IS NULL
           AND invitation.revoked_at IS NULL
           AND invitation.expires_at > now()
         ORDER BY invitation.created_at DESC
         LIMIT 1
       ) invitation ON true
       ORDER BY u.username`,
    );
    return { users: result.rows.map(serializeUser) };
  });

  app.get('/api/v1/roles', {
    preHandler: [authenticated, canReadUsers],
  }, async () => {
    const result = await pool.query(
      `SELECT id, slug, display_name, permissions
       FROM roles
       ORDER BY
         CASE slug
           WHEN 'owner' THEN 1
           WHEN 'content' THEN 2
           WHEN 'fleet' THEN 3
           WHEN 'security' THEN 4
           WHEN 'release' THEN 5
           ELSE 99
         END`,
    );
    return {
      roles: result.rows.map((role) => ({
        id: role.id,
        slug: role.slug,
        displayName: role.display_name,
        permissions: role.permissions,
      })),
    };
  });

  app.post('/api/v1/users', {
    config: { rateLimit: { max: 12, timeWindow: '30 minutes' } },
    preHandler: [authenticated, ownerWrite, csrf],
  }, async (request, reply) => {
    const body = validateOperation(validators, 'invite', {
      username: normalizeUsername(request.body?.username),
      email: normalizeEmail(request.body?.email),
      role: String(request.body?.role ?? ''),
      password: request.body?.password,
      totpCode: String(request.body?.totpCode ?? ''),
    });
    const id = crypto.randomUUID();
    const token = randomToken(32);
    const placeholderPasswordHash = await hashPassword(
      `${randomToken(32)}Aa1!`,
    );
    const placeholderTotp = encryptSecret(
      generateTotpSecret(),
      config.totpEncryptionKey,
    );
    const result = await withTransaction(pool, async (client) => {
      await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: body.password,
        totpCode: body.totpCode,
      });
      const role = await readRole(client, body.role);
      await client.query(
        `INSERT INTO users (
           id, username, email, password_hash, role_id,
           totp_secret_encrypted, active, webauthn_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
        [
          id,
          body.username,
          body.email,
          placeholderPasswordHash,
          role.id,
          JSON.stringify(placeholderTotp),
          Buffer.from(id.replaceAll('-', ''), 'hex'),
        ],
      );
      const invitation = await createInvitation(client, {
        userId: id,
        createdBy: request.roomframeSession.user_id,
        token,
      });
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'user.invited',
        targetType: 'user',
        targetId: id,
        remoteAddress: request.ip,
        details: {
          username: body.username,
          role: role.slug,
          expiresAt: invitation.expiresAt.toISOString(),
        },
      });
      return {
        user: {
          id,
          username: body.username,
          email: body.email,
          active: false,
          status: 'pending',
          role: role.slug,
          role_name: role.display_name,
          invitation_expires_at: invitation.expiresAt,
        },
        invitation,
      };
    });
    return reply.code(201).send({
      user: serializeUser(result.user),
      invitation: {
        activationToken: token,
        expiresAt: result.invitation.expiresAt.toISOString(),
        shownOnce: true,
      },
    });
  });

  app.post('/api/v1/auth/activation/totp', {
    config: { rateLimit: { max: 6, timeWindow: '30 minutes' } },
  }, async (request, reply) => {
    const body = validateOperation(validators, 'activation-start', {
      activationToken: String(request.body?.activationToken ?? ''),
    });
    const secret = generateTotpSecret();
    const challengeId = crypto.randomUUID();
    const challengeExpiresAt = new Date(
      Date.now() + ACTIVATION_MINUTES * 60 * 1000,
    );
    const result = await withTransaction(pool, async (client) => {
      const invitationResult = await client.query(
        `SELECT invitation.id, invitation.user_id, invitation.expires_at,
                invitation.used_at, invitation.revoked_at,
                account.username, account.email, account.active,
                role.slug AS role, role.display_name AS role_name
         FROM user_invitations invitation
         JOIN users account ON account.id = invitation.user_id
         JOIN roles role ON role.id = account.role_id
         WHERE invitation.token_hash = $1
         FOR UPDATE OF invitation`,
        [activationTokenHash(body.activationToken)],
      );
      const invitation = invitationResult.rows[0];
      if (
        !invitation
        || invitation.used_at
        || invitation.revoked_at
        || invitation.active
        || invitation.expires_at <= new Date()
      ) {
        throw routeError('invalid_activation_token', 403);
      }
      await client.query(
        `UPDATE user_invitations
         SET challenge_id = $2,
             totp_secret_encrypted = $3,
             challenge_expires_at = $4
         WHERE id = $1`,
        [
          invitation.id,
          challengeId,
          JSON.stringify(encryptSecret(secret, config.totpEncryptionKey)),
          challengeExpiresAt,
        ],
      );
      await appendAudit(client, {
        session: { user_id: invitation.user_id },
        actorType: 'invitation',
        action: 'user.activation_started',
        targetType: 'user',
        targetId: invitation.user_id,
        remoteAddress: request.ip,
      });
      return invitation;
    });
    return reply.code(201).send({
      challengeId,
      username: result.username,
      email: result.email,
      role: result.role,
      roleName: result.role_name,
      secret,
      otpauthUrl: buildTotpUri({
        secret,
        username: result.username,
      }),
      expiresAt: challengeExpiresAt.toISOString(),
    });
  });

  app.post('/api/v1/auth/activation/complete', {
    config: { rateLimit: { max: 6, timeWindow: '30 minutes' } },
  }, async (request, reply) => {
    const body = validateOperation(validators, 'activation-complete', {
      activationToken: String(request.body?.activationToken ?? ''),
      challengeId: String(request.body?.challengeId ?? ''),
      password: request.body?.password,
      totpCode: String(request.body?.totpCode ?? ''),
    });
    const passwordHash = await hashPassword(body.password);
    const result = await withTransaction(pool, async (client) => {
      const invitationResult = await client.query(
        `SELECT invitation.*, account.username, account.email, account.active,
                role.slug AS role
         FROM user_invitations invitation
         JOIN users account ON account.id = invitation.user_id
         JOIN roles role ON role.id = account.role_id
         WHERE invitation.token_hash = $1
           AND invitation.challenge_id = $2
         FOR UPDATE OF invitation, account`,
        [activationTokenHash(body.activationToken), body.challengeId],
      );
      const invitation = invitationResult.rows[0];
      if (
        !invitation
        || invitation.used_at
        || invitation.revoked_at
        || invitation.active
        || invitation.expires_at <= new Date()
        || invitation.challenge_expires_at <= new Date()
      ) {
        throw routeError('invalid_activation_challenge', 403);
      }
      const totpSecret = decryptSecret(
        invitation.totp_secret_encrypted,
        config.totpEncryptionKey,
      );
      const totpCounter = verifyTotp(totpSecret, body.totpCode);
      if (totpCounter === null) {
        throw routeError('invalid_activation_challenge', 403);
      }
      await client.query(
        `UPDATE users
         SET password_hash = $2,
             totp_secret_encrypted = $3,
             last_totp_counter = $4,
             active = true,
             password_changed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [
          invitation.user_id,
          passwordHash,
          JSON.stringify(encryptSecret(totpSecret, config.totpEncryptionKey)),
          totpCounter,
        ],
      );
      await client.query(
        `UPDATE user_invitations
         SET used_at = now()
         WHERE id = $1`,
        [invitation.id],
      );
      await client.query(
        `UPDATE user_invitations
         SET revoked_at = now()
         WHERE user_id = $1
           AND id <> $2
           AND used_at IS NULL
           AND revoked_at IS NULL`,
        [invitation.user_id, invitation.id],
      );
      await revokeUserAccess(client, invitation.user_id, {
        revokeInvitations: false,
      });
      const user = {
        id: invitation.user_id,
        username: invitation.username,
        email: invitation.email,
        role: invitation.role,
      };
      const session = await issueSession({
        client,
        config,
        user,
        request,
      });
      await appendAudit(client, {
        session: { user_id: user.id },
        actorType: 'invitation',
        action: 'user.activated',
        targetType: 'user',
        targetId: user.id,
        remoteAddress: request.ip,
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

  app.post('/api/v1/users/:userId/role', {
    config: { rateLimit: { max: 12, timeWindow: '30 minutes' } },
    preHandler: [authenticated, ownerWrite, csrf],
  }, async (request) => {
    const userId = validUuid(request.params.userId);
    const body = validateOperation(validators, 'role', {
      role: String(request.body?.role ?? ''),
      password: request.body?.password,
      totpCode: String(request.body?.totpCode ?? ''),
    });
    const user = await withTransaction(pool, async (client) => {
      await lockOwnerInvariant(client);
      await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: body.password,
        totpCode: body.totpCode,
      });
      const target = await readTargetForUpdate(client, userId);
      await assertOwnerCanBeRemoved(client, target);
      assertDifferentUser(target, request.roomframeSession.user_id);
      if (target.role === body.role) throw routeError('role_unchanged', 409);
      const role = await readRole(client, body.role);
      const updated = await client.query(
        `UPDATE users
         SET role_id = $2, updated_at = now()
         WHERE id = $1
         RETURNING id, username, email, active, created_at, updated_at`,
        [target.id, role.id],
      );
      const sessions = await client.query(
        `UPDATE sessions
         SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [target.id],
      );
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'user.role_changed',
        targetType: 'user',
        targetId: target.id,
        remoteAddress: request.ip,
        details: {
          previousRole: target.role,
          nextRole: role.slug,
          revokedSessions: sessions.rowCount,
        },
      });
      return {
        ...updated.rows[0],
        role: role.slug,
        role_name: role.display_name,
      };
    });
    return { user: serializeUser(user) };
  });

  app.post('/api/v1/users/:userId/disable', {
    config: { rateLimit: { max: 12, timeWindow: '30 minutes' } },
    preHandler: [authenticated, ownerWrite, csrf],
  }, async (request) => {
    const userId = validUuid(request.params.userId);
    const body = validateOperation(validators, 'disable', {
      confirmation: String(request.body?.confirmation ?? ''),
      password: request.body?.password,
      totpCode: String(request.body?.totpCode ?? ''),
    });
    const user = await withTransaction(pool, async (client) => {
      await lockOwnerInvariant(client);
      await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: body.password,
        totpCode: body.totpCode,
      });
      const target = await readTargetForUpdate(client, userId);
      await assertOwnerCanBeRemoved(client, target);
      assertDifferentUser(target, request.roomframeSession.user_id);
      assertConfirmation(target, body.confirmation);
      if (!target.active) throw routeError('user_not_active', 409);
      const access = await revokeUserAccess(client, target.id);
      const updated = await client.query(
        `UPDATE users
         SET active = false, last_totp_counter = NULL, updated_at = now()
         WHERE id = $1
         RETURNING id, username, email, active, created_at, updated_at`,
        [target.id],
      );
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'user.disabled',
        targetType: 'user',
        targetId: target.id,
        remoteAddress: request.ip,
        details: access,
      });
      return {
        ...updated.rows[0],
        status: 'disabled',
        role: target.role,
        role_name: target.role_name,
      };
    });
    return { user: serializeUser(user) };
  });

  app.post('/api/v1/users/:userId/invitation', {
    config: { rateLimit: { max: 12, timeWindow: '30 minutes' } },
    preHandler: [authenticated, ownerWrite, csrf],
  }, async (request) => {
    const userId = validUuid(request.params.userId);
    const body = validateOperation(validators, 'reissue', {
      confirmation: String(request.body?.confirmation ?? ''),
      password: request.body?.password,
      totpCode: String(request.body?.totpCode ?? ''),
    });
    const token = randomToken(32);
    const result = await withTransaction(pool, async (client) => {
      await lockOwnerInvariant(client);
      await stepUpUser({
        client,
        config,
        userId: request.roomframeSession.user_id,
        password: body.password,
        totpCode: body.totpCode,
      });
      const target = await readTargetForUpdate(client, userId);
      await assertOwnerCanBeRemoved(client, target);
      assertDifferentUser(target, request.roomframeSession.user_id);
      assertConfirmation(target, body.confirmation);
      const access = await revokeUserAccess(client, target.id);
      await client.query(
        `UPDATE users
         SET active = false, last_totp_counter = NULL, updated_at = now()
         WHERE id = $1`,
        [target.id],
      );
      const invitation = await createInvitation(client, {
        userId: target.id,
        createdBy: request.roomframeSession.user_id,
        token,
      });
      await appendAudit(client, {
        session: request.roomframeSession,
        action: 'user.invitation_reissued',
        targetType: 'user',
        targetId: target.id,
        remoteAddress: request.ip,
        details: {
          ...access,
          expiresAt: invitation.expiresAt.toISOString(),
        },
      });
      return { target, invitation };
    });
    return {
      user: serializeUser({
        ...result.target,
        active: false,
        status: 'pending',
        invitation_expires_at: result.invitation.expiresAt,
      }),
      invitation: {
        activationToken: token,
        expiresAt: result.invitation.expiresAt.toISOString(),
        shownOnce: true,
      },
    };
  });
};
