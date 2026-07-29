import crypto from 'node:crypto';

const lengthPrefix = (major, length) => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65_536) {
    const result = Buffer.alloc(3);
    result[0] = (major << 5) | 25;
    result.writeUInt16BE(length, 1);
    return result;
  }
  throw new Error('cbor_length_not_supported');
};

const cborInteger = (value) => (
  value >= 0
    ? lengthPrefix(0, value)
    : lengthPrefix(1, -1 - value)
);

const cborBytes = (value) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([lengthPrefix(2, bytes.length), bytes]);
};

const cborText = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([lengthPrefix(3, bytes.length), bytes]);
};

const cborMap = (entries) => Buffer.concat([
  lengthPrefix(5, entries.length),
  ...entries.flatMap(([key, value]) => [
    typeof key === 'number' ? cborInteger(key) : cborText(key),
    value,
  ]),
]);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const base64url = (value) => Buffer.from(value).toString('base64url');

const authenticatorPrefix = ({ rpID, flags, counter }) => {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  return Buffer.concat([
    sha256(rpID),
    Buffer.from([flags]),
    counterBytes,
  ]);
};

const clientData = ({ type, challenge, origin }) => Buffer.from(JSON.stringify({
  type,
  challenge,
  origin,
  crossOrigin: false,
}));

export const createRegistrationFixture = ({
  options,
  origin,
  rpID,
}) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  const cosePublicKey = cborMap([
    [1, cborInteger(2)],
    [3, cborInteger(-7)],
    [-1, cborInteger(1)],
    [-2, cborBytes(Buffer.from(jwk.x, 'base64url'))],
    [-3, cborBytes(Buffer.from(jwk.y, 'base64url'))],
  ]);
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    authenticatorPrefix({ rpID, flags: 0x45, counter: 0 }),
    Buffer.alloc(16),
    credentialLength,
    credentialId,
    cosePublicKey,
  ]);
  const attestationObject = cborMap([
    ['fmt', cborText('none')],
    ['attStmt', cborMap([])],
    ['authData', cborBytes(authData)],
  ]);
  const encodedCredentialId = base64url(credentialId);
  return {
    credentialId,
    privateKey,
    response: {
      id: encodedCredentialId,
      rawId: encodedCredentialId,
      response: {
        clientDataJSON: base64url(clientData({
          type: 'webauthn.create',
          challenge: options.challenge,
          origin,
        })),
        attestationObject: base64url(attestationObject),
        transports: ['internal'],
        publicKeyAlgorithm: -7,
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      type: 'public-key',
    },
  };
};

export const createAuthenticationResponse = ({
  options,
  origin,
  rpID,
  fixture,
  counter = 1,
}) => {
  const authenticatorData = authenticatorPrefix({
    rpID,
    flags: 0x05,
    counter,
  });
  const serializedClientData = clientData({
    type: 'webauthn.get',
    challenge: options.challenge,
    origin,
  });
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([authenticatorData, sha256(serializedClientData)]),
    fixture.privateKey,
  );
  const encodedCredentialId = base64url(fixture.credentialId);
  return {
    id: encodedCredentialId,
    rawId: encodedCredentialId,
    response: {
      clientDataJSON: base64url(serializedClientData),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(signature),
      userHandle: null,
    },
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    type: 'public-key',
  };
};
