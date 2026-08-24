import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tvCertificateActivationProofPayload } from '../src/studio-routes.mjs';
import { createValidators } from '../src/validation.mjs';

const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));

test('la preuve activation certificat lie exactement TV demande et empreinte', async () => {
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const fingerprintSha256 = 'ab'.repeat(32);
  const payload = tvCertificateActivationProofPayload(
    deviceId,
    requestId,
    fingerprintSha256,
  );
  assert.equal(
    payload.toString('utf8'),
    `roomframe-tv-certificate-activation-v1\n${deviceId}\n${requestId}\n${fingerprintSha256}`,
  );

  const keyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const proofSignature = crypto.sign(
    'RSA-SHA256',
    payload,
    keyPair.privateKey,
  ).toString('base64url');
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      payload,
      keyPair.publicKey,
      Buffer.from(proofSignature, 'base64url'),
    ),
    true,
  );

  const validators = await createValidators(contractsDir);
  const valid = {
    algorithm: 'RS256',
    requestId,
    fingerprintSha256,
    proofSignature,
  };
  assert.doesNotThrow(() => validators.assertTvCertificateActivation(valid));
  for (const invalid of [
    { ...valid, requestId: deviceId, unexpected: true },
    { ...valid, fingerprintSha256: fingerprintSha256.toUpperCase() },
    { ...valid, proofSignature: `${proofSignature}=` },
  ]) {
    assert.throws(
      () => validators.assertTvCertificateActivation(invalid),
      (error) => error?.message === 'contract_validation_failed',
    );
  }
});
