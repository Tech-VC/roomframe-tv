import crypto from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const encodeBase32 = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
};

export const decodeBase32 = (text) => {
  const normalized = String(text).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('invalid_base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

export const generateTotpSecret = () => encodeBase32(crypto.randomBytes(20));

export const totpAtCounter = (secret, counter, digits = 6) => {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % (10 ** digits)).padStart(digits, '0');
};

export const verifyTotp = (secret, code, {
  now = Date.now(),
  period = 30,
  window = 1,
  lastCounter = null,
} = {}) => {
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(normalized)) return null;
  const currentCounter = Math.floor(now / 1000 / period);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (lastCounter !== null && counter <= Number(lastCounter)) continue;
    const expected = totpAtCounter(secret, counter);
    const a = Buffer.from(normalized);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return counter;
  }
  return null;
};

export const buildTotpUri = ({ secret, username, issuer = 'RoomFrame TV' }) => {
  const label = `${issuer}:${username}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
};
