import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, createAssetResolver, normalizeSyncPayload, stableStringify, variantRank } from "./sync-format.js";

test("normalise un manifeste de synchronisation", () => {
  const payload = normalizeSyncPayload({
    upToDate: false,
    revision: 2,
    manifest: {
      formatVersion: 1,
      kind: "tv-sync",
      revision: 2,
      documents: [{ path: "scene.json", sha256: "b".repeat(64), size: 42 }],
      assets: [{ id: "asset:1080p", assetId: "00000000-0000-4000-8000-000000000123", variant: "1080p", path: "media/asset/1080p", url: "/media/logo", sha256: "a".repeat(64), size: 42 }],
      sha256: "c".repeat(64),
    },
    documents: { scene: { schemaVersion: 2, nodes: [] }, messages: { items: [] } },
  });
  assert.equal(payload.id, "sync-2");
  assert.equal(payload.revisionNumber, 2);
  assert.deepEqual(payload.scene, { schemaVersion: 2, nodes: [] });
  assert.equal(payload.assets[0].key, "media/asset/1080p");
  assert.ok(payload.assets[0].aliases.includes("00000000-0000-4000-8000-000000000123"));
  assert.equal(payload.assets[0].variant, "1080p");
});

test("refuse un hash d’asset incomplet", () => {
  assert.throws(() => normalizeSyncPayload({
    upToDate: false,
    revision: 2,
    manifest: { assets: [{ path: "logo.png", url: "/media/logo", sha256: "abc" }] },
    documents: { scene: { nodes: [] } },
  }), /invalide/);
});

test("accepte la réponse upToDate réelle de l’API", () => {
  assert.deepEqual(normalizeSyncPayload({ upToDate: true, revision: 7 }), {
    upToDate: true,
    revisionNumber: 7,
  });
});

test("canonicalise les clés et convertit les octets en hexadécimal", () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(bytesToHex(Uint8Array.from([0, 15, 255]).buffer), "000fff");
});

test("préfère la variante 1080p pour le renderer fluide", () => {
  assert.ok(variantRank("1080p") > variantRank("4k"));
  assert.ok(variantRank("1080p") > variantRank("thumbnail"));
  const assetId = "00000000-0000-4000-8000-000000000123";
  const standardBlob = new Blob(["standard"]);
  const logoBlob = new Blob(["logo"]);
  const urls = new Map([
    [standardBlob, "blob:standard"],
    [logoBlob, "blob:logo"],
  ]);
  const resolver = createAssetResolver([
    {
      key: "media/example/1080p",
      aliases: [assetId],
      assetId,
      variant: "1080p",
      blob: standardBlob,
    },
    {
      key: "media/example/logo",
      aliases: [assetId],
      assetId,
      variant: "logo",
      blob: logoBlob,
    },
  ], (blob) => urls.get(blob));
  assert.equal(resolver.resolve(assetId), "blob:standard");
  assert.equal(resolver.resolve(assetId, "logo"), "blob:logo");
});
