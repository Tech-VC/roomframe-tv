const LEGACY_ENROLLMENT_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$/;

export const enrollmentCodePresentation = (value) => {
  const normalized = String(value ?? "").trim().toUpperCase();
  const numericFormat = /^\d{16}$/.test(normalized)
    || /^\d{4}(?:[ -]\d{4}){3}$/.test(normalized);

  if (numericFormat) {
    const compactNumeric = normalized.replace(/[ -]/g, "");
    return {
      clipboard: compactNumeric,
      formatted: compactNumeric.match(/.{4}/g).join("-"),
      numeric: true,
      valid: true,
    };
  }

  return {
    clipboard: normalized,
    formatted: normalized,
    numeric: false,
    valid: LEGACY_ENROLLMENT_CODE.test(normalized),
  };
};
