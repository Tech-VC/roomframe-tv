import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationBlockReason, sceneFingerprint } from './scene-workflow.js';

test('publier refuse les modifications locales qui ne figurent pas dans la révision enregistrée', () => {
  const scene = { name: 'Accueil', nodes: [{ props: { text: 'Bonjour' } }] };
  const savedFingerprint = sceneFingerprint(scene);
  scene.nodes[0].props.text = 'Bienvenue';
  assert.equal(publicationBlockReason({ scene, revision: 4, savedFingerprint }),
    'Enregistrez les modifications du brouillon avant de publier.');
});

test('un enregistrement en cours ne peut pas marquer des modifications ultérieures comme sauvegardées', () => {
  const scene = { name: 'Avant enregistrement' };
  const savedFingerprint = sceneFingerprint(scene);
  scene.name = 'Modifié pendant l’enregistrement';
  assert.notEqual(sceneFingerprint(scene), savedFingerprint);
  assert.ok(publicationBlockReason({ scene, revision: 5, savedFingerprint }));
  scene.name = 'Avant enregistrement';
  assert.equal(publicationBlockReason({ scene, revision: 5, savedFingerprint }), null);
});

test('la publication exige une scène et une révision effectivement enregistrée', () => {
  assert.ok(publicationBlockReason({ scene: null, revision: 2, savedFingerprint: null }));
  const scene = { name: 'Nouvelle scène' };
  assert.equal(publicationBlockReason({ scene, revision: null, savedFingerprint: sceneFingerprint(scene) }),
    'Enregistrez d’abord une révision.');
  assert.equal(publicationBlockReason({ scene, revision: 1, savedFingerprint: sceneFingerprint(scene) }), null);
});
