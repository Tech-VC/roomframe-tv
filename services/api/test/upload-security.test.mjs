import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { isMalformedMultipartError } from '../src/multipart-errors.mjs';
import { keyedDigest, SESSION_COOKIE } from '../src/security.mjs';
import { registerStudioRoutes } from '../src/studio-routes.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const upload = (contents, filename = 'image.png') => {
  const boundary = 'roomframe-upload-security-test';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      contents,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
};

const setup = async (t, permissions = ['*']) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-upload-security-'));
  const config = {
    sessionSecret: 'isolated-test-secret',
    publicUrl: 'https://roomframe.test',
    processingDir: path.join(directory, 'processing'),
    mediaDir: path.join(directory, 'media'),
    maxVideoBytes: 1024,
    maxImageBytes: 1024,
    maxUpdateBytes: 1024,
    storageReserveBytes: 0,
  };
  let writes = 0;
  const pool = {
    async query(sql, values) {
      if (sql.includes('FROM sessions s')) return { rows: [{
        session_id: crypto.randomUUID(), user_id: crypto.randomUUID(), permissions,
        csrf_hash: keyedDigest('test-csrf', config.sessionSecret),
      }] };
      if (sql.includes('UPDATE sessions SET last_seen_at')) return { rows: [] };
      writes += 1;
      if (sql.includes('INSERT INTO assets')) return { rows: [{
        id: values[0], sha256: values[1], media_type: values[2],
        original_filename: values[5], byte_size: values[6], processing_status: 'queued',
      }] };
      return { rows: [] };
    },
  };
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.register(cookie);
  await app.register(multipart, {
    attachFieldsToBody: false,
    throwFileSizeLimit: true,
    limits: { files: 1, fields: 8, fileSize: config.maxUpdateBytes },
  });
  registerStudioRoutes({ app, pool, config, validators: {}, experience: {} });
  app.setErrorHandler((error, _request, reply) => reply
    .code(isMalformedMultipartError(error) ? 400 : error.statusCode ?? 500)
    .send({ error: isMalformedMultipartError(error) ? 'invalid_multipart' : error.message }));
  const headers = { cookie: `${SESSION_COOKIE}=test-session`, 'x-csrf-token': 'test-csrf' };
  return { app, config, headers, writes: () => writes };
};

test('un média dépassant la limite multipart est refusé sans stockage ni écriture SQL', async (t) => {
  const { app, config, headers, writes } = await setup(t);
  const request = upload(Buffer.concat([png, Buffer.alloc(2048)]));
  const response = await app.inject({
    method: 'POST', url: '/api/v1/media', ...request,
    headers: { ...request.headers, ...headers },
  });
  assert.equal(response.statusCode, 413, response.body);
  assert.equal(writes(), 0);
  assert.deepEqual(await readdir(config.processingDir), []);
  await assert.rejects(readdir(config.mediaDir), { code: 'ENOENT' });
});

test('les deux imports vérifient session, permission et CSRF avant de parser', async (t) => {
  for (const url of ['/api/v1/media', '/api/v1/releases/import']) {
    const { app, headers, writes } = await setup(t, []);
    const request = upload(png);
    const anonymous = await app.inject({ method: 'POST', url, ...request });
    assert.equal(anonymous.statusCode, 401);
    const forbidden = await app.inject({ method: 'POST', url, ...request, headers: { ...request.headers, ...headers } });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(writes(), 0);
    const permitted = await setup(t);
    const withoutCsrf = await permitted.app.inject({ method: 'POST', url, ...request,
      headers: { ...request.headers, cookie: permitted.headers.cookie } });
    assert.equal(withoutCsrf.statusCode, 403);
    assert.equal(permitted.writes(), 0);
  }
});

test('une frontière multipart fragmentée ne bloque plus et une troncature renvoie 400', async (t) => {
  const { app, headers, writes } = await setup(t);
  const boundary = 'A'.repeat(252);
  const response = await app.inject({
    method: 'POST', url: '/api/v1/media',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Readable.from([Buffer.from('--' + boundary.slice(0, -1)), Buffer.from('X')]),
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'invalid_multipart');
  assert.equal(writes(), 0);
});

test('un nom multipart contenant CR ou LF est refusé sans écriture SQL', async (t) => {
  const { app, headers, writes } = await setup(t);
  for (const name of ['bad\rname.png', 'bad\nname.png']) {
    const request = upload(png, name);
    const response = await app.inject({ method: 'POST', url: '/api/v1/media', ...request,
      headers: { ...request.headers, ...headers } });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(writes(), 0);
});
