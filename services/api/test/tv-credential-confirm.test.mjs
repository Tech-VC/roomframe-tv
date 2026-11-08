import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { registerStudioRoutes } from '../src/studio-routes.mjs';
import { createValidators } from '../src/validation.mjs';

// PostgreSQL is deliberately replaced here: exercise the real HTTP handler and
// certificate policy without connecting to any shared or production database.
const fixture = async (t, { certificate = true } = {}) => {
  const key = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const fingerprint = 'ab'.repeat(32);
  const screen = {
    id: '11111111-1111-4111-8111-111111111111',
    enrollment_state: 'active',
    device_key: 'old-hash',
    device_key_pending: hash,
    device_key_pending_expires_at: new Date(Date.now() + 60000),
    credential_generation: 1,
    client_certificate_fingerprint: certificate ? fingerprint : null,
    client_certificate_required_at: certificate ? new Date(0) : null,
    client_certificate_is_required: certificate,
    client_certificate_pending_is_required: false,
  };
  let mutations = 0;
  const client = {
    release() {},
    async query(sql) {
      if (sql.includes('FROM screens')) return { rows: [{ ...screen }] };
      if (sql.includes('UPDATE screens')) {
        mutations += 1;
        screen.device_key = screen.device_key_pending;
        screen.device_key_pending = null;
        screen.credential_generation += 1;
        screen.device_key_rotated_at = new Date();
        return { rows: [{ ...screen }] };
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('INSERT INTO audit_log')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  const validators = await createValidators(fileURLToPath(new URL('../../../contracts/', import.meta.url)));
  registerStudioRoutes({ app, pool: { connect: async () => client }, config: {}, validators, experience: {} });
  const confirm = (headers = {}) => app.inject({
    method: 'POST', url: '/api/v1/tv/credentials/confirm',
    headers: { 'x-roomframe-device-id': screen.id, 'x-roomframe-device-key': key, ...headers },
    payload: { generation: 2 },
  });
  const tls = { 'x-roomframe-tls-client-verified': '1', 'x-roomframe-tls-client-fingerprint': fingerprint };
  return { confirm, tls, mutations: () => mutations };
};

test('confirmation de clé TV mTLS refuse un certificat absent sans mutation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.confirm()).statusCode, 401);
  assert.equal(f.mutations(), 0);
});

test('confirmation de clé TV mTLS exige le certificat actif et reste idempotente', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.confirm({ ...f.tls, 'x-roomframe-tls-client-fingerprint': 'cd'.repeat(32) })).statusCode, 401);
  assert.equal((await f.confirm({ ...f.tls, 'x-roomframe-tls-client-verified': '0' })).statusCode, 401);
  assert.equal(f.mutations(), 0);
  const first = await f.confirm(f.tls);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().idempotent, false);
  assert.equal((await f.confirm()).statusCode, 401);
  const replay = await f.confirm(f.tls);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().idempotent, true);
  assert.equal(f.mutations(), 1);
});

test('confirmation historique sans certificat conserve la rotation en deux phases', async (t) => {
  const f = await fixture(t, { certificate: false });
  assert.equal((await f.confirm()).statusCode, 200);
  assert.equal((await f.confirm()).json().idempotent, true);
  assert.equal(f.mutations(), 1);
});
