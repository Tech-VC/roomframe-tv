import net from 'node:net';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

export const PASSKEY_CHALLENGE_MINUTES = 5;

const passkeyError = (code, statusCode = 400) => Object.assign(
  new Error(code),
  { statusCode },
);

export const webauthnContext = (config) => {
  let origin;
  try {
    origin = new URL(config.preferredUrl ?? config.publicUrl);
  } catch {
    throw passkeyError('passkey_not_configured', 503);
  }
  const hostname = origin.hostname.toLowerCase();
  if (
    origin.protocol !== 'https:'
    || origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
    || net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
    || !hostname.includes('.')
  ) {
    throw passkeyError('passkey_not_configured', 503);
  }
  return Object.freeze({
    origin: origin.origin,
    rpID: hostname,
  });
};

export const assertPasskeyOrigin = (request, context) => {
  if (request.headers.origin !== context.origin) {
    const error = passkeyError('passkey_canonical_origin_required', 409);
    error.preferredUrl = context.origin;
    throw error;
  }
};

export const registrationOptions = async ({
  context,
  rpName,
  user,
  credentials,
}) => generateRegistrationOptions({
  rpName,
  rpID: context.rpID,
  userID: new Uint8Array(user.webauthn_user_id),
  userName: user.username,
  userDisplayName: user.email ?? user.username,
  attestationType: 'none',
  excludeCredentials: credentials.map((credential) => ({
    id: credential.credential_id.toString('base64url'),
    transports: credential.transports,
  })),
  authenticatorSelection: {
    residentKey: 'preferred',
    userVerification: 'required',
  },
  supportedAlgorithmIDs: [-7, -257],
  timeout: PASSKEY_CHALLENGE_MINUTES * 60 * 1000,
});

export const authenticationOptions = async ({
  context,
  credentials,
}) => generateAuthenticationOptions({
  rpID: context.rpID,
  allowCredentials: credentials.map((credential) => ({
    id: credential.credential_id.toString('base64url'),
    transports: credential.transports,
  })),
  userVerification: 'required',
  timeout: PASSKEY_CHALLENGE_MINUTES * 60 * 1000,
});

export const verifyRegistration = async ({
  response,
  challenge,
}) => {
  try {
    return await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.expected_origin,
      expectedRPID: challenge.rp_id,
      requireUserVerification: true,
    });
  } catch {
    throw passkeyError('invalid_passkey_response');
  }
};

export const verifyAuthentication = async ({
  response,
  challenge,
  credential,
}) => {
  try {
    return await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.expected_origin,
      expectedRPID: challenge.rp_id,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id.toString('base64url'),
        publicKey: new Uint8Array(credential.public_key),
        counter: Number(credential.sign_count),
        transports: credential.transports,
      },
    });
  } catch {
    throw passkeyError('invalid_passkey_response');
  }
};

export const normalizedPasskeyLabel = (value) => {
  const label = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (label.length < 1 || label.length > 80) {
    throw passkeyError('invalid_passkey_label');
  }
  return label;
};

export const credentialIdBuffer = (value) => {
  const encoded = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{22,5462}$/.test(encoded)) {
    throw passkeyError('invalid_passkey_response');
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url');
  } catch {
    throw passkeyError('invalid_passkey_response');
  }
  if (
    decoded.length < 16
    || decoded.length > 4096
    || decoded.toString('base64url') !== encoded
  ) {
    throw passkeyError('invalid_passkey_response');
  }
  return decoded;
};
