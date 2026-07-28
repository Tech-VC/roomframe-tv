import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMediaDeliveryVariants } from '../src/media.mjs';

const descriptor = (name) => ({
  path: `objects/example/${name}`,
  mime: 'image/webp',
  sha256: name.padEnd(64, 'a').slice(0, 64),
  size: 42,
});

const asset = {
  variants: {
    thumbnail: descriptor('thumbnail'),
    '1080p': descriptor('1080p'),
    '4k': descriptor('4k'),
    logo: descriptor('logo'),
  },
};

test('livre la variante alpha pour un média utilisé uniquement comme logo', () => {
  assert.deepEqual(
    selectMediaDeliveryVariants(asset, new Set(['logo'])).map(([name]) => name),
    ['logo'],
  );
});

test('ne remplace pas les variantes visuelles quand le média a un autre usage', () => {
  assert.deepEqual(
    selectMediaDeliveryVariants(asset, new Set(['content'])).map(([name]) => name),
    ['1080p', '4k'],
  );
  assert.deepEqual(
    selectMediaDeliveryVariants(asset, new Set(['logo', 'content'])).map(([name]) => name),
    ['1080p', '4k', 'logo'],
  );
});

test('retombe sur la variante standard si aucun détourage fiable n’existe', () => {
  const withoutLogo = {
    variants: {
      thumbnail: descriptor('thumbnail'),
      '1080p': descriptor('1080p'),
    },
  };
  assert.deepEqual(
    selectMediaDeliveryVariants(withoutLogo, new Set(['logo'])).map(([name]) => name),
    ['1080p'],
  );
});
