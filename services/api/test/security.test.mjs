import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionMaterial,
  decryptSecret,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from '../src/security.mjs';

test('Argon2id hache et vérifie une phrase de passe', async () => {
  const password = 'Correct-Horse-Battery-7!';
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, 'incorrect-password'), false);
  assert.throws(() => hashPassword('password123'), /password_too_weak|invalid_password_length/);
});

test('les secrets TOTP sont chiffrés avec authentification', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptSecret('TOP-SECRET', key);
  assert.notEqual(encrypted.ciphertext, 'TOP-SECRET');
  assert.equal(decryptSecret(encrypted, key), 'TOP-SECRET');
  assert.throws(
    () => decryptSecret({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, key),
  );
});

test('les jetons de session et CSRF sont aléatoires et hachés avec la clé serveur', () => {
  const first = createSessionMaterial('session-key-for-tests');
  const second = createSessionMaterial('session-key-for-tests');
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.token, first.tokenHash);
  assert.equal(first.tokenHash.length, 64);
});
