const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
};

export const stableStringify = (value) => JSON.stringify(sortValue(value));

export const normalizeSyncPayload = (payload) => {
  if (payload?.upToDate === true) {
    const revision = Number(payload.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Révision de synchronisation invalide.");
    return { upToDate: true, revisionNumber: revision };
  }
  const revisionNumber = Number(payload?.revision);
  const manifest = payload?.manifest ?? {};
  const documents = payload?.documents ?? {};
  const scene = documents.scene;
  const rawAssets = manifest.assets ?? [];
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1 || !scene) {
    throw new Error("Réponse de synchronisation incomplète.");
  }
  const assets = rawAssets.map((asset) => ({
    key: String(asset.key ?? asset.path ?? asset.id ?? asset.sha256 ?? ""),
    aliases: [...new Set([asset.id, asset.assetId, asset.path, asset.sha256].filter(Boolean).map(String))],
    assetId: asset.assetId ?? null,
    variant: asset.variant ?? null,
    url: asset.url ?? asset.downloadUrl ?? null,
    sha256: String(asset.sha256 ?? "").toLowerCase(),
    mimeType: asset.mimeType ?? asset.mediaType ?? asset.mime ?? "application/octet-stream",
    size: Number(asset.size ?? 0),
  }));
  if (assets.some((asset) => !asset.key || !asset.url || !/^[a-f0-9]{64}$/.test(asset.sha256))) {
    throw new Error("Manifeste d’assets invalide.");
  }
  const { sha256: manifestHash = null, ...manifestBase } = manifest;
  return {
    upToDate: false,
    id: `sync-${revisionNumber}`,
    revisionNumber,
    scene,
    documents,
    documentEntries: Array.isArray(manifest.documents) ? manifest.documents : [],
    manifestBase,
    manifestHash,
    assets,
    receivedAt: new Date().toISOString(),
  };
};

export const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const variantRank = (variant) => ({
  thumbnail: 0,
  "4k": 1,
  original: 1,
  "1080p": 2,
}[variant] ?? 1);

export const createAssetResolver = (
  assets,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
) => {
  const map = new Map();
  const aliasRanks = new Map();
  const variantAliases = new Map();
  const createdObjectUrls = [];
  for (const asset of assets ?? []) {
    if (!(asset.blob instanceof Blob)) continue;
    const url = createObjectUrl(asset.blob);
    createdObjectUrls.push(url);
    map.set(asset.key, url);
    const aliases = asset.aliases ?? [asset.assetId, asset.sha256].filter(Boolean);
    for (const alias of aliases) {
      if (asset.variant) variantAliases.set(`${alias}:${asset.variant}`, url);
      const rank = variantRank(asset.variant);
      if (!map.has(alias) || rank > (aliasRanks.get(alias) ?? -1)) {
        map.set(alias, url);
        aliasRanks.set(alias, rank);
      }
    }
  }
  return {
    createdObjectUrls,
    resolve(key, preferredVariant = null) {
      if (!key) return null;
      if (/^(blob:|https?:|\/)/.test(key)) return key;
      if (preferredVariant && variantAliases.has(`${key}:${preferredVariant}`)) {
        return variantAliases.get(`${key}:${preferredVariant}`);
      }
      return map.get(key) ?? map.get(String(key).replace(/^assets\//, "")) ?? key;
    },
  };
};
