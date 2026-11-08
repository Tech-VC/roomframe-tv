import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { readApiResponse } from './api-client.js';
import { nodeSupportsLabel, normalizeScene } from './scene-model.js';
import { viewIsAllowed, loadWorkspacePayload } from './workspace-loader.js';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const formatter = (name) => {
  const declaration = source.match(new RegExp(`const ${name} = \\(error\\) => \\([\\s\\S]*?;`));
  assert.ok(declaration, `Formatter ${name} must exist`);
  return vm.runInNewContext(`${declaration[0]}; ${name}`);
};

test('a content manager can reach instance scheduling without fleet permissions', async () => {
  const can = (p) => ['studio:read', 'studio:write'].includes(p);
  assert.equal(viewIsAllowed('fleet', can), true);
  assert.equal(viewIsAllowed('fleet', () => false), false);
  const requested = [];
  await loadWorkspacePayload({ get: async (path) => { requested.push(path); return {}; } }, can);
  assert.deepEqual(requested, ['studio']);
});

test('an empty scene has no label control and does not throw', () => {
  const scene = normalizeScene({ nodes: [] });
  assert.equal(nodeSupportsLabel(scene.nodes[0]), false);
  assert.equal(nodeSupportsLabel(null), false);
  assert.equal(nodeSupportsLabel({ kind: 'source' }), true);
});

for (const [name, code, status, expected] of [
  ['activationErrorMessage', 'invalid_activation_token', 403, /invitation.*expirée/],
  ['enrollmentErrorMessage', 'server_ca_not_ready', 503, /diagnostic serveur/],
]) {
  test(`${name} preserves the actionable API error`, async () => {
    const error = await readApiResponse(new Response(JSON.stringify({ error: code }), {
      status, headers: { 'content-type': 'application/json' },
    })).catch((e) => e);
    assert.match(formatter(name)(error), expected);
  });
}
