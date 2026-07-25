import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createValidators } from '../src/validation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const validators = await createValidators(path.join(root, 'contracts'));

const readJson = async (relative) => JSON.parse(
  await readFile(path.join(root, relative), 'utf8'),
);

test('les contrats acceptent les defaults et exemples versionnés', async () => {
  validators.assertLayout(await readJson('defaults/experience/layout.json'));
  validators.assertContent(await readJson('defaults/experience/content.json'));
  validators.assertSchedule(await readJson('defaults/experience/schedule.json'));
  validators.assertSettings(await readJson('defaults/experience/settings.json'));
  validators.assertExperienceBundle(await readJson('defaults/experience/manifest.json'));
  validators.assertInstance(await readJson('examples/instance.example.json'));
  validators.assertUpdateBundle(await readJson('examples/update-manifest.example.json'));
});

test('une scène hors canevas ou avec props libres est refusée', async () => {
  const layout = await readJson('defaults/experience/layout.json');
  layout.nodes[0].x = 1900;
  assert.throws(() => validators.assertLayout(layout), /node_outside_canvas/);

  const second = await readJson('defaults/experience/layout.json');
  second.nodes[0].props.html = '<script>no</script>';
  assert.throws(() => validators.assertLayout(second), /unsupported_node_property/);

  const typed = await readJson('defaults/experience/layout.json');
  typed.nodes[0].props.fontScale = 'grand';
  assert.throws(() => validators.assertLayout(typed), /invalid_node_property_value/);

  const traversal = await readJson('defaults/experience/layout.json');
  traversal.nodes.find((node) => node.kind === 'logo').props.asset = 'assets/../../private';
  assert.throws(() => validators.assertLayout(traversal), /invalid_node_property_value/);
});

test('un fuseau horaire inconnu est refusé', async () => {
  const schedule = await readJson('defaults/experience/schedule.json');
  schedule.timezone = 'Europe/Does_Not_Exist';
  assert.throws(() => validators.assertSchedule(schedule), /invalid_timezone/);
});
