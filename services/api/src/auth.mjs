import crypto from 'node:crypto';
import {
  SESSION_COOKIE,
  cookieOptions,
  createSessionMaterial,
  csrfTokenForSession,
  hasPermission,
  keyedDigest,
  timingSafeTextEqual,
} from './security.mjs';

const unauthorized = () => Object.assign(new Error('authentication_required'), { statusCode: 401 });
const forbidden = () => Object.assign(new Error('permission_denied'), { statusCode: 403 });

export const sessionFromRequest = async (request, pool, config) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.id AS session_id, s.user_id, s.csrf_hash, s.expires_at,
            u.username, u.email, u.active, r.slug AS role, r.permissions
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.active = true`,
    [keyedDigest(token, config.sessionSecret)],
  );
  const session = result.rows[0] ?? null;
  if (session) {
    pool.query(
      'UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval \'5 minutes\'',
      [session.session_id],
    ).catch(() => {});
  }
  return session;
};

export const requireSession = (pool, config) => async (request) => {
  const session = await sessionFromRequest(request, pool, config);
  if (!session) throw unauthorized();
  request.roomframeSession = session;
};

export const requirePermission = (permission) => async (request) => {
  const session = request.roomframeSession;
  if (!session) throw unauthorized();
  if (!hasPermission(session.permissions, permission)) throw forbidden();
};

const sameOrigin = (request, config) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  const accepted = new Set([
    config.publicUrl,
    config.preferredUrl,
    config.fallbackUrl,
    config.apiUrl ? new URL(config.apiUrl).origin : null,
  ].filter(Boolean));
  return accepted.size === 0 || accepted.has(origin);
};

export const requireCsrf = (config) => async (request) => {
  if (!sameOrigin(request, config)) throw forbidden();
  const session = request.roomframeSession;
  if (!session) throw unauthorized();
  const supplied = request.headers['x-csrf-token'];
  if (
    typeof supplied !== 'string'
    || !timingSafeTextEqual(
      keyedDigest(supplied, config.sessionSecret),
      session.csrf_hash,
    )
  ) {
    throw Object.assign(new Error('csrf_validation_failed'), { statusCode: 403 });
  }
};

export const issueSession = async ({ client, reply, config, user, request }) => {
  const material = createSessionMaterial(config.sessionSecret);
  const expires = new Date(Date.now() + config.sessionHours * 60 * 60 * 1000);
  const sessionId = crypto.randomUUID();
  const csrfToken = csrfTokenForSession(sessionId, config.sessionSecret);
  const csrfHash = keyedDigest(csrfToken, config.sessionSecret);
  await client.query(
    `INSERT INTO sessions (
       id, user_id, token_hash, csrf_hash, expires_at, remote_address, user_agent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      user.id,
      material.tokenHash,
      csrfHash,
      expires,
      request.ip,
      String(request.headers['user-agent'] ?? '').slice(0, 500),
    ],
  );
  reply.setCookie(SESSION_COOKIE, material.token, cookieOptions(expires));
  return { csrfToken, expiresAt: expires.toISOString(), sessionId };
};

export const clearSessionCookie = (reply) => {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
  });
};

export const appendAudit = async (clientOrPool, {
  session = null,
  actorType = 'user',
  action,
  targetType = null,
  targetId = null,
  remoteAddress = null,
  details = {},
}) => {
  await clientOrPool.query(
    `INSERT INTO audit_log (
       actor_user_id, actor_type, action, target_type, target_id, remote_address, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      session?.user_id ?? null,
      actorType,
      action,
      targetType,
      targetId === null ? null : String(targetId),
      remoteAddress,
      JSON.stringify(details),
    ],
  );
};
