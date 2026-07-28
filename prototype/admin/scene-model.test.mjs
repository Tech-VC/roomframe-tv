import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createValidators } from "../../services/api/src/validation.mjs";
import { CANVAS_HEIGHT, CANVAS_WIDTH, DEFAULT_SCENE, cloneScene, createNode, normalizeScene, validateScene } from "./scene-model.js";

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
  assert.equal(scene.nodes[0].props.maxLines, 1);
  assert.equal(scene.nodes[0].focusOrder, 0);
  assert.equal("label" in scene.nodes[0].props, false);
});

test("normalise une salutation sur une seule ligne", () => {
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
  assert.equal(scene.nodes[0].props.text, "Bonjour, bienvenue en salle de réunion 1");
  assert.equal(scene.nodes[0].props.maxLines, 1);
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
  assert.equal(greeting?.props.text, "Bonjour, bienvenue en salle de réunion 1");
  assert.equal(greeting?.props.maxLines, 1);
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
