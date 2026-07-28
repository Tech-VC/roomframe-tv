import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

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
