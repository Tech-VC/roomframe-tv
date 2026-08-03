import assert from "node:assert/strict";
import test from "node:test";
import { weatherDisplayLocation, weatherIconForCode } from "./weather-format.js";

test("retire le code postal uniquement du nom affiché", () => {
  assert.equal(weatherDisplayLocation("Ville Exemple 12345"), "Ville Exemple");
  assert.equal(weatherDisplayLocation("Paris 15e"), "Paris 15e");
});

test("associe les codes WMO à une icône lisible", () => {
  assert.equal(weatherIconForCode(0), "☀️");
  assert.equal(weatherIconForCode(2), "⛅️");
  assert.equal(weatherIconForCode(3), "☁️");
  assert.equal(weatherIconForCode(63), "🌧️");
  assert.equal(weatherIconForCode(73), "❄️");
  assert.equal(weatherIconForCode(95), "⛈️");
});
