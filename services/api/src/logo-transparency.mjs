import sharp from 'sharp';

const MAX_INPUT_PIXELS = 80_000_000;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MIN_LIGHT_LUMINANCE = 210;
const CORNER_CLUSTER_DISTANCE = 32;
const BACKGROUND_DISTANCE = 72;
const MATTE_BACKGROUND_DISTANCE = 180;
const TRANSPARENT_DISTANCE = 14;
const EDGE_FOREGROUND_SEARCH_RADIUS = 4;
const MIN_FOREGROUND_CHANNEL_DISTANCE = 16;
const ENCLOSED_BACKGROUND_SEED_DISTANCE = 28;
const MAX_ENCLOSED_BACKGROUND_COMPONENT_RATIO = 0.025;
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

const clampUnit = (value) => Math.max(0, Math.min(1, value));

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

const nearestForegroundPixel = (
  pixels,
  visited,
  width,
  height,
  x,
  y,
  background,
) => {
  for (let radius = 1; radius <= EDGE_FOREGROUND_SEARCH_RADIUS; radius += 1) {
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const minX = Math.max(0, x - radius);
    const maxX = Math.min(width - 1, x + radius);
    const minY = Math.max(0, y - radius);
    const maxY = Math.min(height - 1, y + radius);
    for (let candidateY = minY; candidateY <= maxY; candidateY += 1) {
      for (let candidateX = minX; candidateX <= maxX; candidateX += 1) {
        if (
          candidateX !== minX
          && candidateX !== maxX
          && candidateY !== minY
          && candidateY !== maxY
        ) {
          continue;
        }
        const index = (candidateY * width) + candidateX;
        if (visited[index]) continue;
        const offset = index * 4;
        const distanceFromBackground = colourDistance(
          pixels[offset],
          pixels[offset + 1],
          pixels[offset + 2],
          background,
        );
        if (
          pixels[offset + 3] === 0
          || (
            distanceFromBackground <= MATTE_BACKGROUND_DISTANCE
            && luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2])
              >= MIN_LIGHT_LUMINANCE - 55
          )
        ) {
          continue;
        }
        const distance = ((candidateX - x) ** 2) + ((candidateY - y) ** 2);
        if (distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearest = {
          red: pixels[offset],
          green: pixels[offset + 1],
          blue: pixels[offset + 2],
        };
      }
    }
    if (nearest) return nearest;
  }
  return null;
};

const compositeOpacity = (red, green, blue, background, foreground) => {
  const source = [red, green, blue];
  const backdrop = [background.red, background.green, background.blue];
  const subject = [foreground.red, foreground.green, foreground.blue];
  const estimates = [];
  for (let channel = 0; channel < source.length; channel += 1) {
    const denominator = subject[channel] - backdrop[channel];
    if (Math.abs(denominator) < MIN_FOREGROUND_CHANNEL_DISTANCE) continue;
    estimates.push(clampUnit((source[channel] - backdrop[channel]) / denominator));
  }
  if (estimates.length === 0) return 0;
  return median(estimates);
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
      ) <= MATTE_BACKGROUND_DISTANCE
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

  const enclosedScanned = new Uint8Array(pixelCount);
  const enclosedQueue = new Int32Array(pixelCount);
  const maxEnclosedPixels = Math.max(
    1,
    Math.floor(pixelCount * MAX_ENCLOSED_BACKGROUND_COMPONENT_RATIO),
  );
  const scanEnclosed = (startIndex) => {
    let enclosedHead = 0;
    let enclosedTail = 1;
    enclosedQueue[0] = startIndex;
    enclosedScanned[startIndex] = 1;
    while (enclosedHead < enclosedTail) {
      const index = enclosedQueue[enclosedHead];
      enclosedHead += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      const inspect = (candidate) => {
        if (
          visited[candidate]
          || enclosedScanned[candidate]
          || !matchesBackground(candidate)
        ) {
          return;
        }
        enclosedScanned[candidate] = 1;
        enclosedQueue[enclosedTail] = candidate;
        enclosedTail += 1;
      };
      if (x > 0) inspect(index - 1);
      if (x + 1 < width) inspect(index + 1);
      if (y > 0) inspect(index - width);
      if (y + 1 < height) inspect(index + width);
    }
    if (enclosedTail > maxEnclosedPixels) return;
    for (let index = 0; index < enclosedTail; index += 1) {
      const candidate = enclosedQueue[index];
      visited[candidate] = 1;
      queue[tail] = candidate;
      tail += 1;
    }
  };
  for (let index = 0; index < pixelCount; index += 1) {
    if (visited[index] || enclosedScanned[index]) continue;
    const offset = index * 4;
    if (
      pixels[offset + 3] === 0
      || colourDistance(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        background,
      ) > ENCLOSED_BACKGROUND_SEED_DISTANCE
    ) {
      continue;
    }
    scanEnclosed(index);
  }

  const removedPixelRatio = tail / pixelCount;
  if (removedPixelRatio < MIN_REMOVED_PIXEL_RATIO) {
    return { applied: false, removedPixelRatio };
  }

  for (let index = 0; index < tail; index += 1) {
    const pixelIndex = queue[index];
    const offset = pixelIndex * 4;
    const distance = colourDistance(
      pixels[offset],
      pixels[offset + 1],
      pixels[offset + 2],
      background,
    );
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const foreground = distance > TRANSPARENT_DISTANCE
      ? nearestForegroundPixel(pixels, visited, width, height, x, y, background)
      : null;
    const opacity = foreground
      ? compositeOpacity(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
        background,
        foreground,
      )
      : 0;
    if (opacity === 0) {
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
    } else if (opacity < 1) {
      pixels[offset] = foreground.red;
      pixels[offset + 1] = foreground.green;
      pixels[offset + 2] = foreground.blue;
    }
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
