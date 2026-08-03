import assert from "node:assert/strict";
import test from "node:test";
import { paletteFromRgba } from "./logo-palette.js";

const pixels = (...colors) => new Uint8ClampedArray(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

test("propose un fond sombre et l’accent chromatique du logo", () => {
  const palette = paletteFromRgba(pixels(
    [20, 20, 18], [20, 20, 18], [20, 20, 18],
    [255, 79, 31], [255, 79, 31], [255, 79, 31],
    [255, 255, 255], [255, 255, 255],
  ));
  assert.deepEqual(palette, { primary: "#141412", accent: "#ff4f1f" });
});

test("ignore les pixels transparents et dérive un compagnon sombre si nécessaire", () => {
  const palette = paletteFromRgba(pixels(
    [0, 255, 0, 0], [0, 255, 0, 0],
    [40, 120, 220], [40, 120, 220], [40, 120, 220],
  ));
  assert.deepEqual(palette, { primary: "#101628", accent: "#2878dc" });
});

test("refuse une image sans pixel exploitable", () => {
  assert.equal(paletteFromRgba(pixels([255, 255, 255, 0])), null);
});
