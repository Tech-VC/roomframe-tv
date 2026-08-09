import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  ENROLLMENT_CODE_BOOTSTRAP_CONTEXT,
  encryptEnrollmentCodeBootstrap,
  enrollmentCodeLookupId,
  formatEnrollmentCode,
  normalizeEnrollmentCode,
  randomEnrollmentCode,
} from '../src/trust-bootstrap.mjs';

const decrypt = ({ encrypted, enrollmentCode }) => {
  const normalized = normalizeEnrollmentCode(enrollmentCode);
  const info = Buffer.from(ENROLLMENT_CODE_BOOTSTRAP_CONTEXT, 'utf8');
  const inputKeyMaterial = crypto
    .createHash('sha256')
    .update(`${ENROLLMENT_CODE_BOOTSTRAP_CONTEXT}\0`, 'utf8')
    .update(normalized, 'ascii')
    .digest();
  const key = Buffer.from(crypto.hkdfSync(
    'sha256',
    inputKeyMaterial,
    encrypted.salt,
    info,
    32,
  ));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.iv);
  decipher.setAAD(info);
  decipher.setAuthTag(encrypted.tag);
  return JSON.parse(Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString('utf8'));
};

test('les nouveaux codes installation contiennent 16 chiffres', () => {
  const generated = randomEnrollmentCode();
  assert.match(generated, /^\d{16}$/);
  const formatted = formatEnrollmentCode(generated);
  assert.match(formatted, /^\d{4}(?:-\d{4}){3}$/);
  assert.equal(normalizeEnrollmentCode(`  ${formatted}  `), generated);
  assert.equal(normalizeEnrollmentCode('0123 4567 8901 2345'), '0123456789012345');
  assert.equal(
    enrollmentCodeLookupId('0123-4567-8901-2345'),
    'bcfca4eee7bcc8aa874bf2336a8e0d4afe4b1a2fe441a2efd56c058f651bf37f',
  );
});

test('les codes alphanumeriques deja emis restent valides pendant leur ticket', () => {
  assert.equal(
    normalizeEnrollmentCode('2345-6789-abcd-efgh'),
    '23456789ABCDEFGH',
  );
  assert.equal(
    enrollmentCodeLookupId('2345-6789-ABCD-EFGH'),
    '805ffeb0f1d0771fc4926c0812fc53ae9329110a493135bc05c90dc6df3cfdf9',
  );
  assert.equal(formatEnrollmentCode('23456789ABCDEFGH'), '2345-6789-ABCD-EFGH');
  assert.throws(() => normalizeEnrollmentCode('0123-4567-89AB-CDEF'), /invalid_enrollment_code/);
  assert.throws(() => normalizeEnrollmentCode('AAAA-AAAA-AAAA-AAA1'), /invalid_enrollment_code/);
});

test('les codes numeriques et historiques dechiffrent uniquement leur enveloppe', () => {
  const cases = [
    ['0123-4567-8901-2345', '0123-4567-8901-2346'],
    ['2345-6789-ABCD-EFGH', '2345-6789-ABCD-EFGJ'],
  ];
  for (const [enrollmentCode, wrongCode] of cases) {
    const enrollmentKey = crypto.randomBytes(32).toString('base64url');
    const certificatePem = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(600)}\n-----END CERTIFICATE-----\n`;
    const encrypted = encryptEnrollmentCodeBootstrap({
      certificatePem,
      certificateFingerprintSha256: 'a'.repeat(64),
      deviceId: '11111111-1111-4111-8111-111111111111',
      enrollmentKey,
      enrollmentCode,
      salt: Buffer.alloc(32, 7),
      iv: Buffer.alloc(12, 9),
    });
    assert.deepEqual(decrypt({ encrypted, enrollmentCode }), {
      version: 1,
      deviceId: '11111111-1111-4111-8111-111111111111',
      enrollmentKey,
      certificatePem,
      certificateFingerprintSha256: 'a'.repeat(64),
    });
    assert.throws(
      () => decrypt({ encrypted, enrollmentCode: wrongCode }),
      /authenticate data|bad decrypt|Unsupported state/i,
    );
  }
});
