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

test('la scène accepte le menu Sources, le raccourci privé historique et refuse une source inconnue', async () => {
  const layout = await readJson('defaults/experience/layout.json');
  const source = layout.nodes.find((node) => node.kind === 'source');
  source.props.source = 'menu';
  assert.equal(validators.assertLayout(layout), layout);

  source.props.source = 'private-app';
  assert.equal(validators.assertLayout(layout), layout);

  source.props.source = 'arbitrary-system-intent';
  assert.throws(() => validators.assertLayout(layout), /invalid_source_kind/);
});

test('le document d’accès privé ne peut transporter aucun vérificateur', () => {
  const policy = {
    schemaVersion: 1,
    enabled: true,
    pinConfigured: true,
    generation: 3,
    maxAttempts: 5,
    lockoutSeconds: 60,
  };
  assert.equal(validators.assertPrivateAccess(policy), policy);
  assert.throws(
    () => validators.assertPrivateAccess({ ...policy, pinHash: 'interdit' }),
    /contract_validation_failed/,
  );
});

test('un fuseau horaire inconnu est refusé', async () => {
  const schedule = await readJson('defaults/experience/schedule.json');
  schedule.timezone = 'Europe/Does_Not_Exist';
  assert.throws(() => validators.assertSchedule(schedule), /invalid_timezone/);
});

test('le nom synchronisé de la TV reste borné et sur une ligne', () => {
  const device = {
    schemaVersion: 1,
    displayName: 'Salle de réunion 01',
    roomName: 'Salle de réunion',
  };
  assert.equal(validators.assertTvDevice(device), device);
  assert.throws(
    () => validators.assertTvDevice({ ...device, displayName: 'Salle\ninterdite' }),
    /contract_validation_failed/,
  );
});

test('le contrat de découverte borne les origines et la signature', () => {
  const descriptor = {
    formatVersion: 1,
    serviceType: '_roomframe._tcp',
    path: '/api/v1/discovery',
    origin: 'https://roomframe.example.local',
    fallbackOrigin: 'https://192.0.2.24',
    host: 'roomframe.example.local',
    ipv4: '192.0.2.24',
    port: 443,
    serverCaFingerprintSha256: 'a'.repeat(64),
    generatedAt: '2026-07-29T12:00:00Z',
    signing: {
      algorithm: 'ECDSA-P256-SHA256',
      publicKeySpki: 'A'.repeat(100),
      publicKeyFingerprintSha256: 'b'.repeat(64),
      signature: 'C'.repeat(90),
    },
  };
  assert.equal(validators.assertDiscovery(descriptor), descriptor);
  assert.throws(
    () => validators.assertDiscovery({ ...descriptor, origin: 'http://192.0.2.24' }),
    /contract_validation_failed/,
  );
});
