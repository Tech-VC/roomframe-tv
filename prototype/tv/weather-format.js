export const weatherDisplayLocation = (value) => String(value ?? "")
  .trim()
  .replace(/\s+\d{4,6}$/u, "")
  .trim();

export const weatherIconForCode = (value) => {
  const code = Number(value);
  if (!Number.isInteger(code)) return "🌡️";
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "⛅️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
};
