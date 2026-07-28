import sharp from 'sharp';

const MAX_INPUT_PIXELS = 80_000_000;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MIN_LIGHT_LUMINANCE = 210;
const CORNER_CLUSTER_DISTANCE = 32;
const BACKGROUND_DISTANCE = 72;
const TRANSPARENT_DISTANCE = 14;
const MIN_BORDER_MATCH_RATIO = 0.62;
const MIN_REMOVED_PIXEL_RATIO = 0.08;

const luminance = (red, green, blue) => (
  (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
);

const colourDistance = (red, green, blue, background) => Math.sqrt(
  ((red - background.red) ** 2)
  + ((green - background.green) ** 2)
  + ((blue - background.blue) ** 2),
);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const pixelOffset = (width, x, y) => ((y * width) + x) * 4;

const sampleCorner = (pixels, width, height, startX, startY, size) => {
  const red = [];
  const green = [];
  const blue = [];
  for (let y = startY; y < Math.min(height, startY + size); y += 1) {
    for (let x = startX; x < Math.min(width, startX + size); x += 1) {
      const offset = pixelOffset(width, x, y);
      if (pixels[offset + 3] < 245) continue;
      red.push(pixels[offset]);
      green.push(pixels[offset + 1]);
      blue.push(pixels[offset + 2]);
    }
  }
  if (red.length < Math.max(1, Math.floor((size * size) / 2))) return null;
  return {
    red: median(red),
    green: median(green),
    blue: median(blue),
  };
};

const detectLightBackground = (pixels, width, height) => {
  const cornerSize = Math.max(2, Math.min(16, Math.floor(Math.min(width, height) * 0.025)));
  const corners = [
    sampleCorner(pixels, width, height, 0, 0, cornerSize),
    sampleCorner(pixels, width, height, width - cornerSize, 0, cornerSize),
    sampleCorner(pixels, width, height, 0, height - cornerSize, cornerSize),
    sampleCorner(pixels, width, height, width - cornerSize, height - cornerSize, cornerSize),
  ].filter((corner) => (
    corner
    && luminance(corner.red, corner.green, corner.blue) >= MIN_LIGHT_LUMINANCE
  ));

  let cluster = [];
  for (const candidate of corners) {
    const matches = corners.filter((corner) => (
      colourDistance(corner.red, corner.green, corner.blue, candidate)
      <= CORNER_CLUSTER_DISTANCE
    ));
    if (matches.length > cluster.length) cluster = matches;
  }
  if (cluster.length < 3) return null;

  const background = {
    red: median(cluster.map((corner) => corner.red)),
    green: median(cluster.map((corner) => corner.green)),
    blue: median(cluster.map((corner) => corner.blue)),
  };
  let matchingBorderPixels = 0;
  let opaqueBorderPixels = 0;
  const inspect = (x, y) => {
    const offset = pixelOffset(width, x, y);
    if (pixels[offset + 3] < 245) return;
    opaqueBorderPixels += 1;
    if (
      colourDistance(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        background,
      ) <= BACKGROUND_DISTANCE
    ) {
      matchingBorderPixels += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    inspect(x, 0);
    if (height > 1) inspect(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    inspect(0, y);
    if (width > 1) inspect(width - 1, y);
  }
  if (
    opaqueBorderPixels === 0
    || matchingBorderPixels / opaqueBorderPixels < MIN_BORDER_MATCH_RATIO
  ) {
    return null;
  }
  return background;
};

const hasUsefulSourceTransparency = (pixels, width, height) => {
  const pixelCount = width * height;
  let transparentPixels = 0;
  let transparentBorderPixels = 0;
  let borderPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (pixels[(index * 4) + 3] < 245) transparentPixels += 1;
  }
  const inspectBorder = (x, y) => {
    borderPixels += 1;
    if (pixels[pixelOffset(width, x, y) + 3] < 245) transparentBorderPixels += 1;
  };
  for (let x = 0; x < width; x += 1) {
    inspectBorder(x, 0);
    if (height > 1) inspectBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    inspectBorder(0, y);
    if (width > 1) inspectBorder(width - 1, y);
  }
  return (
    transparentPixels / pixelCount >= 0.01
    || (borderPixels > 0 && transparentBorderPixels / borderPixels >= 0.2)
  );
};

const removeConnectedBackground = (pixels, width, height, background) => {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let tail = 0;

  const matchesBackground = (index) => {
    const offset = index * 4;
    return (
      pixels[offset + 3] > 0
      && luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2])
        >= MIN_LIGHT_LUMINANCE - 55
      && colourDistance(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        background,
      ) <= BACKGROUND_DISTANCE
    );
  };
  const enqueue = (index) => {
    if (visited[index] || !matchesBackground(index)) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    if (height > 1) enqueue(((height - 1) * width) + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    if (width > 1) enqueue((y * width) + width - 1);
  }

  for (let head = 0; head < tail; head += 1) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  const removedPixelRatio = tail / pixelCount;
  if (removedPixelRatio < MIN_REMOVED_PIXEL_RATIO) {
    return { applied: false, removedPixelRatio };
  }

  for (let index = 0; index < tail; index += 1) {
    const offset = queue[index] * 4;
    const distance = colourDistance(
      pixels[offset],
      pixels[offset + 1],
      pixels[offset + 2],
      background,
    );
    const opacity = Math.max(
      0,
      Math.min(1, (distance - TRANSPARENT_DISTANCE) / (
        BACKGROUND_DISTANCE - TRANSPARENT_DISTANCE
      )),
    );
    pixels[offset + 3] = Math.min(
      pixels[offset + 3],
      Math.round(pixels[offset + 3] * opacity),
    );
  }
  return { applied: true, removedPixelRatio };
};

const writeWebp = (pixels, width, height, output) => sharp(pixels, {
  raw: {
    width,
    height,
    channels: 4,
  },
})
  .webp({ quality: 90, alphaQuality: 100, effort: 4 })
  .toFile(output);

export const generateTransparentLogoVariant = async (input, output) => {
  const { data, info } = await sharp(input, {
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) throw new Error('logo_variant_channels_invalid');

  if (hasUsefulSourceTransparency(data, info.width, info.height)) {
    await writeWebp(data, info.width, info.height, output);
    return {
      generated: true,
      backgroundRemoved: false,
      reason: 'source_already_transparent',
      removedPixelRatio: 0,
    };
  }

  const background = detectLightBackground(data, info.width, info.height);
  if (!background) {
    return {
      generated: false,
      backgroundRemoved: false,
      reason: 'light_uniform_background_not_detected',
      removedPixelRatio: 0,
    };
  }

  const removal = removeConnectedBackground(data, info.width, info.height, background);
  if (!removal.applied) {
    return {
      generated: false,
      backgroundRemoved: false,
      reason: 'connected_background_too_small',
      removedPixelRatio: removal.removedPixelRatio,
    };
  }

  await writeWebp(data, info.width, info.height, output);
  return {
    generated: true,
    backgroundRemoved: true,
    reason: 'light_uniform_background_removed',
    removedPixelRatio: removal.removedPixelRatio,
  };
};
