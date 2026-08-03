import assert from "node:assert/strict";
import test from "node:test";
import { activeMessagesForNode, formatClockText } from "./presentation.js";

test("affiche la date française et l’heure avec un h", () => {
  const value = new Date("2026-07-02T16:15:00.000Z");
  assert.equal(
    formatClockText({ showDate: true, format: "24h", timezone: "Europe/Paris" }, value),
    "2 Juillet - 18h15",
  );
});

test("masque un bloc de messages vide et limite les messages actifs", () => {
  const node = { props: { maximumItems: 1 } };
  const now = new Date("2026-08-03T16:00:00.000Z");
  const items = activeMessagesForNode(node, [
    { title: "Passé", active: true, ends_at: "2026-08-03T15:59:59.000Z" },
    { title: "Présent", active: true, starts_at: "2026-08-03T15:00:00.000Z" },
    { title: "Suivant", active: true },
  ], now);
  assert.deepEqual(items.map((item) => item.title), ["Présent"]);
  assert.deepEqual(activeMessagesForNode(node, [], now), []);
});
