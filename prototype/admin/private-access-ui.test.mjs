import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPrivatePin,
  privateAccessPolicyMatches,
  privateAccessPolicySummary,
} from "./private-access-ui.js";

test("le code privé est affiché en deux groupes sans modifier sa valeur", () => {
  assert.equal(formatPrivatePin("123456"), "123 456");
  assert.equal(formatPrivatePin("123-456"), "123 456");
  assert.equal(formatPrivatePin("12345"), "");
  assert.equal(formatPrivatePin("abc123456"), "");
});

test("une politique reste liée à sa cible exacte", () => {
  assert.equal(privateAccessPolicyMatches({ target_type: "instance", target_id: null }, "instance", null), true);
  assert.equal(privateAccessPolicyMatches({ targetType: "tv", targetId: "tv-1" }, "tv", "tv-1"), true);
  assert.equal(privateAccessPolicyMatches({ targetType: "tv", targetId: "tv-2" }, "tv", "tv-1"), false);
});

test("le résumé ne révèle jamais le code", () => {
  assert.equal(privateAccessPolicySummary(), "Aucun code créé.");
  assert.equal(
    privateAccessPolicySummary({ enabled: true, pin_configured: true, pin_generation: 3 }),
    "Verrou activé · génération 3",
  );
  assert.equal(
    privateAccessPolicySummary({ enabled: false, pinConfigured: true, pinGeneration: 4 }),
    "Verrou désactivé · génération 4",
  );
});
