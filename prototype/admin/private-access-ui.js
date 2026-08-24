export const formatPrivatePin = (value) => {
  const digits = String(value ?? "").trim().replace(/[\s-]/gu, "");
  return /^\d{6}$/u.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3)}` : "";
};

export const privateAccessPolicyMatches = (policy, targetType, targetId) => (
  (policy?.targetType ?? policy?.target_type) === targetType
  && (policy?.targetId ?? policy?.target_id ?? null) === (targetId ?? null)
);

export const privateAccessPolicySummary = (policy) => {
  if (!policy) return "Aucun code créé.";
  const configured = Boolean(policy.pinConfigured ?? policy.pin_configured);
  const enabled = Boolean(policy.enabled);
  if (!configured) return enabled ? "Verrou activé · créez un code." : "Aucun code créé.";
  const generation = Number(policy.pinGeneration ?? policy.pin_generation);
  const suffix = Number.isSafeInteger(generation) && generation > 0
    ? ` · génération ${generation}`
    : "";
  return `${enabled ? "Verrou activé" : "Verrou désactivé"}${suffix}`;
};
