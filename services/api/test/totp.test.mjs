import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTotpUri,
  totpAtCounter,
  verifyTotp,
} from '../src/totp.mjs';

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP suit le vecteur RFC 6238 SHA-1', () => {
  assert.equal(totpAtCounter(rfcSecret, 1, 8), '94287082');
  assert.equal(totpAtCounter(rfcSecret, 1), '287082');
});

test('TOTP accepte la fenêtre et refuse la répétition', () => {
  assert.equal(verifyTotp(rfcSecret, '287082', { now: 59_000, window: 0 }), 1);
  assert.equal(
    verifyTotp(rfcSecret, '287082', { now: 59_000, window: 0, lastCounter: 1 }),
    null,
  );
  assert.equal(verifyTotp(rfcSecret, '000000', { now: 59_000, window: 0 }), null);
});

test('URI TOTP reste générique et correctement échappée', () => {
  const uri = buildTotpUri({ secret: rfcSecret, username: 'admin local' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /RoomFrame%20TV%3Aadmin%20local/);
  assert.match(uri, /issuer=RoomFrame\+TV/);
});
