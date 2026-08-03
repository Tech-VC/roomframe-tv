import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createValidators } from "../../services/api/src/validation.mjs";
import { weatherLocationKey } from "../../services/api/src/weather.mjs";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_SCENE,
  activeMessagesForNode,
  cloneScene,
  createNode,
  formatClockText,
  nodeDisplayText,
  normalizeScene,
  validateScene,
  weatherDisplayLocation,
  weatherIconForCode,
} from "./scene-model.js";

test("migre la forme historique vers layout.schema v2", () => {
  const scene = normalizeScene({
    layoutId: "scene",
    canvas: { background: { type: "image", mode: "cover" } },
    nodes: [{ id: "welcome", kind: "greeting", x: 0, y: 0, w: 500, h: 200, content: "Bonjour" }],
  });
  assert.equal(scene.schemaVersion, 2);
  assert.equal(scene.canvas.width, CANVAS_WIDTH);
  assert.equal(scene.canvas.height, CANVAS_HEIGHT);
  assert.equal(scene.nodes[0].kind, "text");
  assert.equal(scene.nodes[0].width, 500);
  assert.equal(scene.nodes[0].props.text, "Bonjour");
  assert.equal(scene.nodes[0].props.role, "greeting");
  assert.equal(scene.nodes[0].props.maxLines, 2);
  assert.equal(scene.nodes[0].focusOrder, 0);
  assert.equal("label" in scene.nodes[0].props, false);
});

test("préserve une salutation sur deux lignes", () => {
  const scene = normalizeScene({
    layoutId: "scene",
    canvas: { background: { type: "color", mode: "cover" } },
    nodes: [{
      id: "greeting",
      kind: "text",
      x: 0,
      y: 0,
      width: 1000,
      height: 200,
      props: {
        role: "greeting",
        text: "Bonjour,\n  bienvenue en salle de réunion 1",
        maxLines: 3,
      },
    }],
  });
  assert.equal(scene.nodes[0].props.text, "Bonjour,\nbienvenue en salle de réunion 1");
  assert.equal(scene.nodes[0].props.maxLines, 2);
});

test("normalise le flou du fond et le borne à quarante pixels", () => {
  const blurred = normalizeScene({
    layoutId: "scene",
    canvas: { background: { type: "image", mode: "cover", blur: 18 } },
    nodes: [],
  });
  assert.equal(blurred.canvas.background.blur, 18);
  blurred.canvas.background.blur = 99;
  assert.equal(normalizeScene(blurred).canvas.background.blur, 40);
  blurred.canvas.background.blur = -4;
  assert.equal(normalizeScene(blurred).canvas.background.blur, 0);
});

test("contraint un nouvel objet dans la scène", () => {
  const node = createNode("source", "hdmi");
  assert.equal(node.kind, "source");
  assert.equal(node.props.source, "hdmi");
  assert.equal(node.focusOrder, 1);
  const scene = validateScene({
    layoutId: "scene",
    canvas: { background: { type: "color", mode: "cover" } },
    nodes: [node],
  });
  assert.ok(scene.nodes[0].x + scene.nodes[0].width <= CANVAS_WIDTH);
});

test("refuse les identifiants dupliqués", () => {
  const node = createNode("text");
  assert.throws(() => validateScene({
    layoutId: "scene",
    canvas: { background: { type: "color", mode: "cover" } },
    nodes: [node, structuredClone(node)],
  }), /dupliqué/);
});

test("la scène UI par défaut passe le validateur API réel", async () => {
  const contractsDirectory = fileURLToPath(new URL("../../contracts/", import.meta.url));
  const validators = await createValidators(contractsDirectory);
  assert.doesNotThrow(() => validators.assertLayout(cloneScene(DEFAULT_SCENE)));
  const greeting = DEFAULT_SCENE.nodes.find(
    (node) => node.kind === "text" && node.props.role === "greeting",
  );
  assert.equal(greeting?.props.text, "Bonjour,\nBienvenue en salle de réunion 1");
  assert.equal(greeting?.props.maxLines, 2);
  const paletteScene = cloneScene(DEFAULT_SCENE);
  paletteScene.nodes = [
    createNode("text"),
    createNode("clock"),
    createNode("weather"),
    createNode("message"),
    createNode("image"),
    createNode("video"),
    createNode("logo"),
    createNode("source", "airplay"),
    createNode("source", "cast"),
    createNode("source", "hdmi"),
    createNode("app"),
    createNode("network"),
  ];
  paletteScene.nodes.forEach((node, index) => {
    node.x = (index % 4) * 450;
    node.y = Math.floor(index / 4) * 300;
    node.width = 400;
    node.height = 200;
  });
  assert.doesNotThrow(() => validators.assertLayout(paletteScene));
});

test("une météo exige une suggestion géocodée et reste indépendante de l’instance", async () => {
  const contractsDirectory = fileURLToPath(new URL("../../contracts/", import.meta.url));
  const validators = await createValidators(contractsDirectory);
  const weather = createNode("weather");
  weather.props.location = "Ville Exemple 12345";
  assert.throws(
    () => validateScene({ ...cloneScene(DEFAULT_SCENE), nodes: [weather] }),
    /Choisissez une suggestion valide/,
  );
  Object.assign(weather.props, {
    latitude: 47.3431,
    longitude: 1.18653,
    timezone: "Europe/Paris",
    units: "metric",
  });
  weather.props.locationKey = weatherLocationKey(weather.props);
  const scene = validateScene({ ...cloneScene(DEFAULT_SCENE), nodes: [weather] });
  assert.doesNotThrow(() => validators.assertLayout(scene));
  assert.equal(createNode("weather").props.location, "");
});

test("la météo affiche un nom court et une icône adaptée", () => {
  const weather = createNode("weather");
  Object.assign(weather.props, {
    location: "Ville Exemple 12345",
    locationKey: "weather-key",
  });
  const weatherDocument = {
    items: [{
      key: "weather-key",
      location: "Ville Exemple 12345",
      temperature: 31.2,
      temperatureUnit: "°C",
      weatherCode: 3,
      condition: "Couvert",
      status: "fresh",
    }],
  };
  assert.equal(weatherDisplayLocation(weather.props.location), "Ville Exemple");
  assert.equal(weatherIconForCode(3), "☁️");
  assert.equal(nodeDisplayText(weather, weatherDocument), "Ville Exemple\n☁️ 31 °C · Couvert");

  weatherDocument.items[0].status = "stale";
  assert.equal(nodeDisplayText(weather, weatherDocument), "Ville Exemple\n☁️ 31 °C · Couvert");
});

test("l’horloge affiche une date française lisible et une heure compacte", () => {
  assert.equal(
    formatClockText(
      { showDate: true, format: "24h", timezone: "Europe/Paris" },
      new Date("2026-07-02T16:15:00.000Z"),
    ),
    "2 Juillet - 18h15",
  );
  assert.equal(
    formatClockText(
      { showDate: false, format: "24h", timezone: "Europe/Paris" },
      new Date("2026-07-02T16:15:00.000Z"),
    ),
    "18h15",
  );
});

test("un bloc Actualités ne reçoit que ses messages actifs", () => {
  const node = createNode("message");
  node.props.maximumItems = 2;
  const messages = activeMessagesForNode(node, [
    { title: "Inactif", active: false },
    { title: "Terminé", active: true, ends_at: "2026-08-03T15:59:59.000Z" },
    { title: "En cours", active: true, starts_at: "2026-08-03T15:00:00.000Z" },
    { title: "Permanent", active: true },
    { title: "En trop", active: true },
  ], new Date("2026-08-03T16:00:00.000Z"));
  assert.deepEqual(messages.map((message) => message.title), ["En cours", "Permanent"]);
});
