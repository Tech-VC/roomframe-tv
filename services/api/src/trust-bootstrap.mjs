import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const SERVER_TRUST_BOOTSTRAP_CONTEXT = 'roomframe-server-ca-bootstrap-v1';
export const ENROLLMENT_CODE_BOOTSTRAP_CONTEXT = 'roomframe-enrollment-code-bootstrap-v1';

const numericEnrollmentCodeAlphabet = '0123456789';
const legacyEnrollmentCodeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const enrollmentCodeLength = 16;

export const normalizeEnrollmentCode = (value) => {
  const normalized = String(value ?? '')
    .toUpperCase()
    .replaceAll(/[-\s]/g, '');
  const numericCode = [...normalized]
    .every((character) => numericEnrollmentCodeAlphabet.includes(character));
  const legacyCode = [...normalized]
    .every((character) => legacyEnrollmentCodeAlphabet.includes(character));
  if (
    normalized.length !== enrollmentCodeLength
    || (!numericCode && !legacyCode)
  ) {
    throw new Error('invalid_enrollment_code');
  }
  return normalized;
};

export const formatEnrollmentCode = (value) => (
  normalizeEnrollmentCode(value).match(/.{4}/g).join('-')
);

export const randomEnrollmentCode = () => {
  return Array.from({ length: enrollmentCodeLength })
    .map(() => numericEnrollmentCodeAlphabet[
      crypto.randomInt(numericEnrollmentCodeAlphabet.length)
    ])
    .join('');
};

const normalizedFingerprint = (certificate) => (
  certificate.fingerprint256.replaceAll(':', '').toLowerCase()
);

export const trustBootstrapInfo = (deviceId) => Buffer.from(
  `${SERVER_TRUST_BOOTSTRAP_CONTEXT}\n${deviceId}`,
  'utf8',
);

export const loadServerCa = async (file) => {
  let pem;
  try {
    pem = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error('server_ca_not_ready'), { statusCode: 503 });
    }
    throw error;
  }
  if (
    pem.length < 500
    || pem.length > 16_384
    || !pem.startsWith('-----BEGIN CERTIFICATE-----')
    || !pem.trimEnd().endsWith('-----END CERTIFICATE-----')
  ) {
    throw Object.assign(new Error('server_ca_invalid'), { statusCode: 503 });
  }
  let certificate;
  try {
    certificate = new crypto.X509Certificate(pem);
  } catch {
    throw Object.assign(new Error('server_ca_invalid'), { statusCode: 503 });
  }
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !certificate.ca
    || !Number.isFinite(validFrom)
    || !Number.isFinite(validTo)
    || validFrom > now
    || validTo <= now
  ) {
    throw Object.assign(new Error('server_ca_invalid'), { statusCode: 503 });
  }
  try {
    if (!certificate.verify(certificate.publicKey)) {
      throw new Error('not_self_signed');
    }
  } catch {
    throw Object.assign(new Error('server_ca_invalid'), { statusCode: 503 });
  }
  return {
    pem,
    fingerprintSha256: normalizedFingerprint(certificate),
  };
};

export const encryptServerTrustBootstrap = ({
  certificatePem,
  certificateFingerprintSha256,
  deviceId,
  enrollmentKey,
  salt = crypto.randomBytes(32),
  iv = crypto.randomBytes(12),
}) => {
  if (
    !Buffer.isBuffer(salt)
    || salt.length !== 32
    || !Buffer.isBuffer(iv)
    || iv.length !== 12
  ) {
    throw new Error('invalid_trust_bootstrap_nonce');
  }
  const keyMaterial = Buffer.from(String(enrollmentKey), 'base64url');
  if (
    keyMaterial.length !== 32
    || keyMaterial.toString('base64url') !== enrollmentKey
  ) {
    throw new Error('invalid_trust_bootstrap_key');
  }
  if (!/^[a-f0-9]{64}$/.test(certificateFingerprintSha256)) {
    throw new Error('invalid_server_ca_fingerprint');
  }
  const info = trustBootstrapInfo(deviceId);
  const key = Buffer.from(crypto.hkdfSync('sha256', keyMaterial, salt, info, 32));
  const plaintext = Buffer.from(certificatePem, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(info);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    salt,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
    fingerprintSha256: certificateFingerprintSha256,
  };
};

const enrollmentCodeKeyMaterial = (enrollmentCode) => crypto
  .createHash('sha256')
  .update(`${ENROLLMENT_CODE_BOOTSTRAP_CONTEXT}\0`, 'utf8')
  .update(normalizeEnrollmentCode(enrollmentCode), 'ascii')
  .digest();

export const enrollmentCodeLookupId = (enrollmentCode) => (
  enrollmentCodeKeyMaterial(enrollmentCode).toString('hex')
);

export const encryptEnrollmentCodeBootstrap = ({
  certificatePem,
  certificateFingerprintSha256,
  deviceId,
  enrollmentKey,
  enrollmentCode,
  salt = crypto.randomBytes(32),
  iv = crypto.randomBytes(12),
}) => {
  if (
    !Buffer.isBuffer(salt)
    || salt.length !== 32
    || !Buffer.isBuffer(iv)
    || iv.length !== 12
  ) {
    throw new Error('invalid_enrollment_code_bootstrap_nonce');
  }
  const keyBytes = Buffer.from(String(enrollmentKey), 'base64url');
  if (
    keyBytes.length !== 32
    || keyBytes.toString('base64url') !== enrollmentKey
  ) {
    throw new Error('invalid_trust_bootstrap_key');
  }
  if (!/^[a-f0-9]{64}$/.test(certificateFingerprintSha256)) {
    throw new Error('invalid_server_ca_fingerprint');
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(deviceId))) {
    throw new Error('invalid_enrollment_device_id');
  }
  const info = Buffer.from(ENROLLMENT_CODE_BOOTSTRAP_CONTEXT, 'utf8');
  const key = Buffer.from(crypto.hkdfSync(
    'sha256',
    enrollmentCodeKeyMaterial(enrollmentCode),
    salt,
    info,
    32,
  ));
  const plaintext = Buffer.from(JSON.stringify({
    version: 1,
    deviceId,
    enrollmentKey,
    certificatePem,
    certificateFingerprintSha256,
  }), 'utf8');
  if (plaintext.length < 500 || plaintext.length > 32_768) {
    throw new Error('invalid_enrollment_code_bootstrap_payload');
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(info);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    salt,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
  };
};

export const serializeServerTrustBootstrap = (row) => ({
  version: 1,
  algorithm: 'AES-256-GCM',
  keyDerivation: 'HKDF-SHA256',
  context: SERVER_TRUST_BOOTSTRAP_CONTEXT,
  salt: row.server_ca_bootstrap_salt.toString('base64url'),
  iv: row.server_ca_bootstrap_iv.toString('base64url'),
  ciphertext: row.server_ca_bootstrap_ciphertext.toString('base64url'),
  tag: row.server_ca_bootstrap_tag.toString('base64url'),
});

export const serializeEnrollmentCodeBootstrap = (row) => ({
  version: 1,
  algorithm: 'AES-256-GCM',
  keyDerivation: 'HKDF-SHA256',
  context: ENROLLMENT_CODE_BOOTSTRAP_CONTEXT,
  salt: row.enrollment_code_bootstrap_salt.toString('base64url'),
  iv: row.enrollment_code_bootstrap_iv.toString('base64url'),
  ciphertext: row.enrollment_code_bootstrap_ciphertext.toString('base64url'),
  tag: row.enrollment_code_bootstrap_tag.toString('base64url'),
});
