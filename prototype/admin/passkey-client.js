const base64urlPattern = /^[A-Za-z0-9_-]+$/;

export const bytesFromBase64url = (value) => {
  const encoded = String(value ?? '');
  if (!encoded || !base64urlPattern.test(encoded)) {
    throw new Error("Donnée passkey invalide.");
  }
  const padding = "=".repeat((4 - encoded.length % 4) % 4);
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const base64urlFromBytes = (value) => {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const credentialDescriptor = (descriptor) => ({
  ...descriptor,
  id: bytesFromBase64url(descriptor.id),
});

export const creationOptionsFromJSON = (options) => {
  if (typeof globalThis.PublicKeyCredential?.parseCreationOptionsFromJSON === "function") {
    return globalThis.PublicKeyCredential.parseCreationOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: bytesFromBase64url(options.challenge),
    user: {
      ...options.user,
      id: bytesFromBase64url(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials ?? []).map(credentialDescriptor),
  };
};

export const requestOptionsFromJSON = (options) => {
  if (typeof globalThis.PublicKeyCredential?.parseRequestOptionsFromJSON === "function") {
    return globalThis.PublicKeyCredential.parseRequestOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: bytesFromBase64url(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(credentialDescriptor),
  };
};

const optionalBytes = (value) => (
  value == null ? null : base64urlFromBytes(value)
);

export const credentialToJSON = (credential) => {
  if (typeof credential?.toJSON === "function") return credential.toJSON();
  const response = credential?.response;
  if (!credential || !response) throw new Error("Réponse passkey absente.");
  const serialized = {
    id: credential.id,
    rawId: base64urlFromBytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: base64urlFromBytes(response.clientDataJSON),
    },
  };
  if ("attestationObject" in response) {
    serialized.response.attestationObject = base64urlFromBytes(response.attestationObject);
    serialized.response.transports = response.getTransports?.() ?? [];
    const publicKey = response.getPublicKey?.();
    if (publicKey) serialized.response.publicKey = base64urlFromBytes(publicKey);
    const algorithm = response.getPublicKeyAlgorithm?.();
    if (Number.isInteger(algorithm)) serialized.response.publicKeyAlgorithm = algorithm;
    const authenticatorData = response.getAuthenticatorData?.();
    if (authenticatorData) {
      serialized.response.authenticatorData = base64urlFromBytes(authenticatorData);
    }
  } else {
    serialized.response.authenticatorData = base64urlFromBytes(response.authenticatorData);
    serialized.response.signature = base64urlFromBytes(response.signature);
    serialized.response.userHandle = optionalBytes(response.userHandle);
  }
  return serialized;
};

export const passkeysAvailable = () => (
  window.isSecureContext
  && "PublicKeyCredential" in window
  && typeof navigator.credentials?.create === "function"
  && typeof navigator.credentials?.get === "function"
);
