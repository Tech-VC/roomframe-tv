import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createTrustedProxy } from '../src/trusted-proxy.mjs';

test('la confiance valide l’adresse du proxy et se limite au premier saut', () => {
  const trust = createTrustedProxy('192.0.2.2/32');
  assert.equal(trust('192.0.2.2', 0), true);
  assert.equal(trust('::ffff:192.0.2.2', 0), true);
  assert.equal(trust('192.0.2.3', 0), false);
  assert.equal(trust('192.0.2.2', 1), false);
  assert.equal(trust('invalid', 0), false);
  assert.equal(createTrustedProxy('')('127.0.0.1', 0), false);
  assert.equal(createTrustedProxy()('fc00::2', 0), true);
  assert.equal(createTrustedProxy()('203.0.113.5', 0), false);
  assert.throws(() => createTrustedProxy('invalid-cidr'), /invalid|IP|address/i);
});

test('Fastify conserve le vrai client derrière Caddy et ignore les proxys antérieurs forgés', async (t) => {
  const app = Fastify({ trustProxy: createTrustedProxy('192.0.2.2/32') });
  t.after(() => app.close());
  app.get('/', (request) => ({ ip: request.ip, host: request.host, protocol: request.protocol }));
  const headers = {
    host: 'roomframe.test',
    'x-forwarded-for': '203.0.113.99, 198.51.100.22',
    'x-forwarded-host': 'trusted.roomframe.test',
    'x-forwarded-proto': 'https',
  };
  const trusted = await app.inject({ url: '/', remoteAddress: '192.0.2.2', headers });
  assert.deepEqual(trusted.json(), { ip: '198.51.100.22', host: 'trusted.roomframe.test', protocol: 'https' });
  const direct = await app.inject({ url: '/', remoteAddress: '198.51.100.22', headers });
  assert.deepEqual(direct.json(), { ip: '198.51.100.22', host: 'roomframe.test', protocol: 'http' });
});
