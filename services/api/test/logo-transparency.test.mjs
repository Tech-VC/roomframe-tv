import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { generateTransparentLogoVariant } from '../src/logo-transparency.mjs';

const makeTemporaryDirectory = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomframe-logo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const opaqueLogoJpeg = async () => {
  const width = 160;
  const height = 90;
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 22; y < 68; y += 1) {
    for (let x = 32; x < 128; x += 1) {
      const offset = ((y * width) + x) * 3;
      pixels[offset] = 5;
      pixels[offset + 1] = 74;
      pixels[offset + 2] = 145;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
    .toBuffer();
};

test('retire seulement le fond clair relié aux bords du logo', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, 'logo.webp');
  const result = await generateTransparentLogoVariant(await opaqueLogoJpeg(), output);

  assert.equal(result.generated, true);
  assert.equal(result.backgroundRemoved, true);
  assert.equal(result.reason, 'light_uniform_background_removed');
  assert.ok(result.removedPixelRatio > 0.4);

  const { data, info } = await sharp(output)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(((y * info.width) + x) * 4) + 3];
  assert.equal(alphaAt(0, 0), 0);
  assert.ok(alphaAt(Math.floor(info.width / 2), Math.floor(info.height / 2)) > 245);
});

test('ne crée pas de variante transparente quand le fond est ambigu', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, 'logo.webp');
  const width = 120;
  const height = 80;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = ((y * width) + x) * 3;
      pixels[offset] = Math.round((x / width) * 255);
      pixels[offset + 1] = Math.round((y / height) * 255);
      pixels[offset + 2] = 80;
    }
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const result = await generateTransparentLogoVariant(input, output);

  assert.equal(result.generated, false);
  assert.equal(result.reason, 'light_uniform_background_not_detected');
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('normalise un logo déjà transparent sans supprimer ses couleurs', async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const output = path.join(directory, 'logo.webp');
  const width = 100;
  const height = 60;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 15; y < 45; y += 1) {
    for (let x = 20; x < 80; x += 1) {
      const offset = ((y * width) + x) * 4;
      pixels[offset] = 210;
      pixels[offset + 1] = 35;
      pixels[offset + 2] = 20;
      pixels[offset + 3] = 255;
    }
  }

  const result = await generateTransparentLogoVariant(
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    output,
  );
  assert.equal(result.generated, true);
  assert.equal(result.backgroundRemoved, false);
  assert.equal(result.reason, 'source_already_transparent');

  const { data, info } = await sharp(output)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0);
  const centre = (
    ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * 4
  );
  assert.ok(data[centre] > 180);
  assert.equal(data[centre + 3], 255);
});
