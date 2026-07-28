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
