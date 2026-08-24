export const MANUAL_ANDROID_APP = "__manual__";
export const MAX_PRIVATE_ANDROID_APPS = 12;

const ANDROID_APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export const ANDROID_TV_APPS = Object.freeze([
  Object.freeze({
    name: "CANAL+",
    applicationId: "com.canal.android.canal",
  }),
  Object.freeze({
    name: "YouTube",
    applicationId: "com.google.android.youtube.tv",
  }),
]);

export const androidTvAppForId = (applicationId) => ANDROID_TV_APPS.find(
  (entry) => entry.applicationId === String(applicationId ?? "").trim(),
) ?? null;

export const androidTvAppSelection = (applicationId) => {
  const normalized = String(applicationId ?? "").trim();
  if (!normalized) return "";
  return androidTvAppForId(normalized)?.applicationId ?? MANUAL_ANDROID_APP;
};

export const resolvedAndroidApplicationId = (selection, manualApplicationId = "") => (
  selection === MANUAL_ANDROID_APP
    ? String(manualApplicationId).trim()
    : String(selection ?? "").trim()
);

export const validAndroidApplicationId = (value) => (
  ANDROID_APPLICATION_ID.test(String(value ?? "").trim())
);

export const normalizePrivateAndroidApplicationIds = (
  configuration = {},
  maximum = MAX_PRIVATE_ANDROID_APPS,
) => {
  const source = Array.isArray(configuration?.applicationIds)
    ? configuration.applicationIds
    : [configuration?.applicationId];
  const result = [];
  const seen = new Set();
  for (const value of source) {
    const applicationId = String(value ?? "").trim();
    if (!validAndroidApplicationId(applicationId) || seen.has(applicationId)) continue;
    result.push(applicationId);
    seen.add(applicationId);
    if (result.length >= maximum) break;
  }
  return result;
};

export const androidTvAppDisplayName = (applicationId, customIndex = 1) => (
  androidTvAppForId(applicationId)?.name ?? `Application personnalisée ${customIndex}`
);

export const privateApplicationStatus = (status = null) => ({
  availability: status?.installed === true
    ? "Installée"
    : status?.installed === false
      ? "Absente"
      : "Inconnue",
  access: status?.accessEnforced === true || status?.access_enforced === true
    ? "Protection confirmée"
    : "Protection non confirmée",
});
