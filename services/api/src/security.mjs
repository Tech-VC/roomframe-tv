import crypto from 'node:crypto';
import argon2 from 'argon2';

export const SESSION_COOKIE = '__Host-roomframe_session';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const keyedDigest = (value, key) => crypto.createHmac('sha256', String(key)).update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const timingSafeTextEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const normalizeUsername = (value) => {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(username)) {
    throw Object.assign(new Error('invalid_username'), { statusCode: 400 });
  }
  return username;
};

export const normalizeEmail = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error('invalid_email'), { statusCode: 400 });
  }
  return email;
};

export const validatePassword = (value) => {
  const password = String(value ?? '');
  if (password.length < 12 || password.length > 256) {
    throw Object.assign(new Error('invalid_password_length'), { statusCode: 400 });
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3 || /^(password|motdepasse|roomframe|administrator)/i.test(password)) {
    throw Object.assign(new Error('password_too_weak'), { statusCode: 400 });
  }
  return password;
};

export const hashPassword = (password) => argon2.hash(validatePassword(password), {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

export const verifyPassword = async (hash, password) => {
  try {
    return await argon2.verify(hash, String(password ?? ''), { type: argon2.argon2id });
  } catch {
    return false;
  }
};

const deriveEncryptionKey = (material) => {
  const decoded = Buffer.from(String(material), 'base64');
  if (decoded.length === 32) return decoded;
  return crypto.createHash('sha256').update(String(material)).digest();
};

export const encryptSecret = (plaintext, keyMaterial) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
};

export const decryptSecret = (record, keyMaterial) => {
  if (!record || record.version !== 1 || record.algorithm !== 'aes-256-gcm') {
    throw new Error('unsupported_encrypted_secret');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveEncryptionKey(keyMaterial),
    Buffer.from(record.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

export const createSessionMaterial = (sessionSecret) => {
  const token = randomToken(32);
  return {
    token,
    tokenHash: keyedDigest(token, sessionSecret),
  };
};

export const csrfTokenForSession = (sessionId, sessionSecret) => keyedDigest(
  `csrf:${sessionId}`,
  sessionSecret,
);

export const cookieOptions = (expires) => ({
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
  expires,
});

export const hasPermission = (permissions, expected) => (
  Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(expected))
);
