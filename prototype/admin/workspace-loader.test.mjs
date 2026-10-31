import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspacePayload, viewIsAllowed } from './workspace-loader.js';

test('le rôle Versions charge son espace sans demander un accès Studio interdit', async () => {
  const permissions = ['instance:read', 'fleet:read', 'releases:read'];
  const can = (permission) => permissions.includes(permission);
  const requested = [];
  const api = { async get(endpoint) {
    requested.push(endpoint);
    const responses = {
      instance: { displayName: 'Organisation' },
      tvs: { tvs: [{ id: 'tv-1' }] },
      groups: { groups: [{ id: 'group-1' }] },
      releases: { releases: [{ version: '0.3.20' }], source: { enabled: true } },
    };
    assert.ok(endpoint in responses, `Accès non autorisé : ${endpoint}`);
    return responses[endpoint];
  } };
  const result = await loadWorkspacePayload(api, can);
  assert.deepEqual(requested, ['instance', 'tvs', 'groups', 'releases']);
  assert.equal(result.scene, null);
  assert.equal(result.releases[0].version, '0.3.20');
  assert.equal(viewIsAllowed('surface', can), false);
  assert.equal(viewIsAllowed('releases', can), true);
});

test('le rôle Sécurité ne demande aucune donnée de scène ou de version', async () => {
  const can = (permission) => ['instance:read', 'fleet:read', 'users:read'].includes(permission);
  const requested = [];
  const result = await loadWorkspacePayload({ async get(endpoint) { requested.push(endpoint); return {}; } }, can);
  assert.deepEqual(requested, ['instance', 'tvs', 'groups']);
  assert.deepEqual(result.releases, []);
  assert.equal(viewIsAllowed('security', can), true);
  assert.equal(viewIsAllowed('releases', can), false);
});

test('un éditeur charge le document Studio sélectionné et conserve les erreurs réseau', async () => {
  const calls = [];
  const can = () => true;
  const result = await loadWorkspacePayload({ async get(endpoint) { calls.push(endpoint); return { scene: { id: 'scene-1' } }; } }, can, 'scene-1');
  assert.deepEqual(calls, ['studio?sceneId=scene-1']);
  assert.equal(result.scene.id, 'scene-1');
  await assert.rejects(loadWorkspacePayload({ get: () => Promise.reject(new Error('offline')) }, can), /offline/);
});
