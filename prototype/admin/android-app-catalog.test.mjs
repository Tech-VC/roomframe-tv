import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDROID_TV_APPS,
  MANUAL_ANDROID_APP,
  MAX_PRIVATE_ANDROID_APPS,
  androidTvAppDisplayName,
  androidTvAppForId,
  androidTvAppSelection,
  normalizePrivateAndroidApplicationIds,
  privateApplicationStatus,
  resolvedAndroidApplicationId,
  validAndroidApplicationId,
} from "./android-app-catalog.js";

test("le catalogue masque les identifiants Android de CANAL+ et YouTube", () => {
  assert.deepEqual(
    ANDROID_TV_APPS.map(({ name, applicationId }) => [name, applicationId]),
    [
      ["CANAL+", "com.canal.android.canal"],
      ["YouTube", "com.google.android.youtube.tv"],
    ],
  );
});

test("une application connue se sélectionne par son nom lisible", () => {
  assert.equal(androidTvAppSelection("com.canal.android.canal"), "com.canal.android.canal");
  assert.equal(androidTvAppForId("com.google.android.youtube.tv")?.name, "YouTube");
});

test("une application non répertoriée conserve la saisie manuelle", () => {
  assert.equal(androidTvAppSelection("org.example.application"), MANUAL_ANDROID_APP);
  assert.equal(
    resolvedAndroidApplicationId(MANUAL_ANDROID_APP, " org.example.application "),
    "org.example.application",
  );
});

test("la sélection privée accepte plusieurs applications et l’ancien champ unique", () => {
  assert.deepEqual(
    normalizePrivateAndroidApplicationIds({
      applicationIds: [
        "com.canal.android.canal",
        " com.google.android.youtube.tv ",
        "com.canal.android.canal",
        "identifiant invalide",
      ],
    }),
    ["com.canal.android.canal", "com.google.android.youtube.tv"],
  );
  assert.deepEqual(
    normalizePrivateAndroidApplicationIds({ applicationId: "org.example.application" }),
    ["org.example.application"],
  );
  assert.equal(MAX_PRIVATE_ANDROID_APPS, 12);
});

test("les identifiants techniques inconnus restent cantonnés au mode avancé", () => {
  assert.equal(validAndroidApplicationId("org.example.application"), true);
  assert.equal(validAndroidApplicationId("pas un paquet"), false);
  assert.equal(androidTvAppDisplayName("com.canal.android.canal"), "CANAL+");
  assert.equal(androidTvAppDisplayName("org.example.application", 2), "Application personnalisée 2");
});

test("le statut privé distingue disponibilité et verrouillage", () => {
  assert.deepEqual(privateApplicationStatus({ installed: true, access_enforced: true }), {
    availability: "Installée",
    access: "Protection confirmée",
  });
  assert.deepEqual(privateApplicationStatus({ installed: false, accessEnforced: false }), {
    availability: "Absente",
    access: "Protection non confirmée",
  });
  assert.deepEqual(privateApplicationStatus(), {
    availability: "Inconnue",
    access: "Protection non confirmée",
  });
});
