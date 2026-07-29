import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { registerBootstrapAuthRoutes } from './bootstrap-auth-routes.mjs';
import { createPool } from './database.mjs';
import { loadVerifiedDefaultExperience } from './seed.mjs';
import { registerStudioRoutes } from './studio-routes.mjs';
import { createValidators } from './validation.mjs';

export const buildApp = async ({ config, logger = true }) => {
  const app = Fastify({
    logger: logger ? {
      level: process.env.ROOMFRAME_LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-csrf-token',
          'req.headers.x-roomframe-device-key',
          'req.body.password',
          'req.body.bootstrapToken',
          'req.body.recoveryToken',
          'req.body.enrollmentKey',
          'req.body.nextKey',
          'req.body.totpCode',
        ],
        censor: '[REDACTED]',
      },
    } : false,
    bodyLimit: 1024 * 1024,
    // Caddy est l'unique proxy devant l'API. Ne faire confiance qu'à ce saut
    // évite qu'un client du LAN forge sa provenance via X-Forwarded-For.
    trustProxy: 1,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);
  await app.register(multipart, {
    attachFieldsToBody: false,
    throwFileSizeLimit: true,
    limits: {
      files: 1,
      fields: 8,
      fieldNameSize: 100,
      fieldSize: 64 * 1024,
      fileSize: config.maxUpdateBytes,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    hook: 'onRequest',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'rate_limit_exceeded',
      message: 'Trop de requêtes. Réessayez plus tard.',
    }),
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    return payload;
  });

  const pool = createPool(config.database);
  try {
    const validators = await createValidators(config.contractsDir);
    const experience = await loadVerifiedDefaultExperience(config.defaultBundleDir, validators);

    app.get('/health', async (_request, reply) => {
      const database = await pool.query(
        `SELECT
           EXISTS (SELECT 1 FROM roomframe_instance WHERE singleton = true) AS configured,
           (SELECT revision FROM sync_state WHERE singleton = true) AS sync_revision`,
      );
      return reply.send({
        ok: true,
        service: 'roomframe-api',
        version: config.version,
        database: 'ready',
        configured: Boolean(database.rows[0].configured),
        syncRevision: Number(database.rows[0].sync_revision ?? 1),
        defaultExperience: {
          bundleId: experience.manifest.bundleId,
          version: experience.manifest.version,
          verified: true,
        },
      });
    });

    registerBootstrapAuthRoutes({
      app,
      pool,
      config,
      validators,
      experience,
    });
    registerStudioRoutes({
      app,
      pool,
      config,
      validators,
      experience,
    });

    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.setErrorHandler((error, request, reply) => {
      let status = Number(error.statusCode ?? 500);
      let code = error.message ?? 'internal_error';
      if (error.code === '23505') {
        status = 409;
        code = 'conflict';
      } else if (
        error.code === '23503'
        || error.code === '23514'
        || error.code === '22P02'
        || error.code === '22003'
      ) {
        status = 400;
        code = error.code === '23503' ? 'invalid_reference' : 'invalid_value';
      }
      if (status >= 500) {
        request.log.error({ err: error }, 'request_failed');
        code = error.message === 'insufficient_storage'
          ? 'insufficient_storage'
          : 'internal_error';
      }
      return reply.code(status).send({
        error: code,
        ...(status < 500 && error.validation ? { validation: error.validation } : {}),
        ...(status === 409 && error.currentRevision
          ? { currentRevision: error.currentRevision }
          : {}),
      });
    });

    app.addHook('onClose', async () => pool.end());
    return { app, pool, validators, experience };
  } catch (error) {
    await pool.end();
    throw error;
  }
};
