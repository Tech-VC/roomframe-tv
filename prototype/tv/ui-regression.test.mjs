import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("l’accueil TV garde ses boutons sobres et la météo sans crédit superposé", () => {
  assert.doesNotMatch(source, /source-action|make\("a", "weather-attribution"/);
  assert.doesNotMatch(styles, /\.source-action|\.weather-attribution/);
  assert.match(source, /aria-label[\s\S]*Données météo : Open-Meteo/);
});

test("l’accueil masque les actualités vides et affiche une horloge renforcée", () => {
  assert.match(source, /activeMessagesForNode\(node, messagesDocument\)/);
  assert.match(source, /node\.kind === "message" && messageItems\.length === 0/);
  assert.match(styles, /\.kind-clock \{[^}]*font-size: 1\.55cqw/);
  assert.match(styles, /\.message-entry/);
});
