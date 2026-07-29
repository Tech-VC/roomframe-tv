import test from "node:test";
import assert from "node:assert/strict";
import {
  base64urlFromBytes,
  bytesFromBase64url,
  credentialToJSON,
  requestOptionsFromJSON,
} from "./passkey-client.js";

test("convertit strictement les valeurs base64url WebAuthn", () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  const encoded = base64urlFromBytes(bytes);
  assert.equal(encoded, "AAEC_f7_");
  assert.deepEqual([...bytesFromBase64url(encoded)], [...bytes]);
  assert.throws(() => bytesFromBase64url("AAEC+/=="), /passkey invalide/);
});

test("prépare les options et sérialise une assertion sans toJSON", () => {
  const challenge = base64urlFromBytes(Uint8Array.from([1, 2, 3, 4]));
  const credentialId = base64urlFromBytes(Uint8Array.from([5, 6, 7, 8]));
  const options = requestOptionsFromJSON({
    challenge,
    allowCredentials: [{ id: credentialId, type: "public-key" }],
    rpId: "roomframe.example.test",
  });
  assert.deepEqual([...options.challenge], [1, 2, 3, 4]);
  assert.deepEqual([...options.allowCredentials[0].id], [5, 6, 7, 8]);

  const serialized = credentialToJSON({
    id: credentialId,
    rawId: Uint8Array.from([5, 6, 7, 8]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: Uint8Array.from([9, 10]).buffer,
      authenticatorData: Uint8Array.from([11, 12]).buffer,
      signature: Uint8Array.from([13, 14]).buffer,
      userHandle: null,
    },
  });
  assert.equal(serialized.id, credentialId);
  assert.equal(serialized.response.clientDataJSON, "CQo");
  assert.equal(serialized.response.authenticatorData, "Cww");
  assert.equal(serialized.response.signature, "DQ4");
  assert.equal(serialized.response.userHandle, null);
});
