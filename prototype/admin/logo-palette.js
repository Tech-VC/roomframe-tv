const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));

const rgbToHex = ({ r, g, b }) => `#${[r, g, b]
  .map((value) => clampByte(value).toString(16).padStart(2, "0"))
  .join("")}`;

const colorDistance = (left, right) => Math.hypot(
  left.r - right.r,
  left.g - right.g,
  left.b - right.b,
);

const luminance = ({ r, g, b }) => (
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
);

const saturation = ({ r, g, b }) => {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  return maximum === 0 ? 0 : (maximum - minimum) / maximum;
};

const darkCompanion = (color) => ({
  r: Math.max(16, color.r * 0.18),
  g: Math.max(16, color.g * 0.18),
  b: Math.max(16, color.b * 0.18),
});

export const paletteFromRgba = (rgba) => {
  if (!rgba || typeof rgba.length !== "number" || rgba.length < 4) return null;
  const buckets = new Map();
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    const alpha = Number(rgba[index + 3]);
    if (!Number.isFinite(alpha) || alpha < 160) continue;
    const r = Number(rgba[index]);
    const g = Number(rgba[index + 1]);
    const b = Number(rgba[index + 2]);
    if (![r, g, b].every(Number.isFinite)) continue;
    const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const colors = [...buckets.values()]
    .filter((bucket) => bucket.count >= 2)
    .map((bucket) => ({
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
      count: bucket.count,
    }))
    .map((color) => ({
      ...color,
      luminance: luminance(color),
      saturation: saturation(color),
    }));
  if (!colors.length) return null;

  const visible = colors.filter((color) => !(color.luminance > 0.94 && color.saturation < 0.08));
  const candidates = visible.length ? visible : colors;
  const accent = candidates
    .filter((color) => color.saturation >= 0.18 && color.luminance >= 0.08 && color.luminance <= 0.9)
    .sort((left, right) => (
      right.count * (0.65 + right.saturation)
      - left.count * (0.65 + left.saturation)
    ))[0] ?? candidates.sort((left, right) => right.count - left.count)[0];

  const primary = candidates
    .filter((color) => color !== accent && color.luminance <= 0.42 && colorDistance(color, accent) >= 42)
    .sort((left, right) => (
      right.count * (1.15 - right.luminance)
      - left.count * (1.15 - left.luminance)
    ))[0] ?? darkCompanion(accent);

  return {
    primary: rgbToHex(primary),
    accent: rgbToHex(accent),
  };
};
