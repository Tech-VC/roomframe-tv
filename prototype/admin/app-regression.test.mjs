import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const markup = await readFile(new URL("./index.html", import.meta.url), "utf8");

test("les formulaires asynchrones conservent leur référence après un await", () => {
  assert.doesNotMatch(source, /event\.currentTarget\.reset\(\)/);
  assert.match(
    source,
    /\$\("#loginForm"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*?const form = event\.currentTarget;[\s\S]*?const data = new FormData\(form\);[\s\S]*?form\.reset\(\);/,
  );
  assert.match(
    source,
    /\$\("#bootstrapForm"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*?const form = event\.currentTarget;[\s\S]*?const data = new FormData\(form\);[\s\S]*?form\.reset\(\);/,
  );
});

test("la récupération locale est utilisable et efface les secrets affichés", () => {
  assert.match(markup, /id="recoveryPanel"/);
  assert.match(markup, /id="recoveryToken"[^>]*type="password"/);
  assert.match(source, /api\.post\("auth\/recovery\/totp"/);
  assert.match(source, /api\.post\("auth\/recovery\/complete"/);
  assert.match(source, /\$\("#recoveryTotpSecret"\)\.textContent = ""/);
  assert.match(source, /\$\("#recoveryTotpCode"\)\.required = false/);
});

test("l’aperçu TV ou groupe reste séparé du brouillon modifiable", () => {
  assert.match(markup, /id="targetSelect"/);
  assert.match(source, /api\.get\(`studio\/preview\?\$\{query\}`\)/);
  assert.match(source, /const displayedScene = \(\) => state\.preview\?\.scene \?\? state\.scene/);
  assert.match(source, /if \(!state\.scene \|\| state\.preview\) return;/);
  assert.match(source, /state\.preview = null;[\s\S]*state\.selectedId = state\.scene\?\.nodes\[0\]\?\.id/);
});

test("les règles de salle utilisent des formulaires structurés et l’API atomique", () => {
  assert.match(markup, /id="sourceSettingsForm"/);
  assert.match(markup, /id="powerSettingsForm"/);
  assert.match(markup, /id="powerWeekdaysEnabled"/);
  assert.match(markup, /son adaptateur confirme la capacité/);
  assert.match(source, /api\.put\("settings\/sources"/);
  assert.match(source, /api\.put\("settings\/power"/);
  assert.doesNotMatch(markup, /textarea[^>]*id="(?:source|power)/);
});

test("la bibliothèque de scènes sépare chargement, copie et affectation publiée", () => {
  assert.match(markup, /id="sceneLibrarySelect"/);
  assert.match(markup, /id="sceneLoadButton"/);
  assert.match(markup, /id="sceneCloneName"/);
  assert.match(markup, /id="sceneAssignmentForm"/);
  assert.match(source, /api\.post\("scenes", \{ name, scene \}\)/);
  assert.match(source, /api\.put\("scene-assignments"/);
  assert.match(source, /studio\?sceneId=/);
  assert.match(markup, /abandonne les modifications non enregistrées/);
  assert.match(markup, /id="automaticReleaseSource"/);
  assert.match(source, /state\.releaseSource = payload\.source \?\? null/);
  assert.match(source, /Aucun déploiement n’a été lancé automatiquement/);
  assert.match(markup, /id="serverUpdateForm"/);
  assert.match(markup, /Retaper la version/);
  assert.match(markup, /sans donner root au web/);
  assert.match(source, /server-update-requests/);
  assert.match(source, /state\.serverUpdateRequests/);
});
