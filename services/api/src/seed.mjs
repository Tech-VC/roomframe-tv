import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize } from './canonical.mjs';
import { sha256 } from './security.mjs';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const listRegularFiles = async (directory, relative = '') => {
  const files = [];
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`default_bundle_symlink_forbidden:${child}`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(directory, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`default_bundle_special_file_forbidden:${child}`);
  }
  return files;
};

export const loadVerifiedDefaultExperience = async (directory, validators) => {
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  validators.assertExperienceBundle(manifest);
  const seen = new Set();
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) throw new Error('duplicate_default_bundle_path');
    seen.add(entry.path);
    const absolute = path.resolve(directory, entry.path);
    if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw new Error('unsafe_default_bundle_path');
    }
    const data = await readFile(absolute);
    if (data.length !== entry.size || sha256(data) !== entry.sha256) {
      throw new Error(`default_bundle_integrity_failed:${entry.path}`);
    }
  }
  for (const entrypoint of Object.values(manifest.entrypoints)) {
    if (!seen.has(entrypoint)) throw new Error(`unlisted_default_bundle_entrypoint:${entrypoint}`);
  }
  const expectedFiles = new Set(['manifest.json', ...seen]);
  const actualFiles = await listRegularFiles(directory);
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) throw new Error(`unlisted_default_bundle_file:${file}`);
  }
  if (actualFiles.length !== expectedFiles.size) {
    throw new Error('default_bundle_file_set_mismatch');
  }
  const [layout, content, schedule, settings] = await Promise.all([
    readJson(path.join(directory, manifest.entrypoints.layout)),
    readJson(path.join(directory, manifest.entrypoints.content)),
    readJson(path.join(directory, manifest.entrypoints.schedule)),
    readJson(path.join(directory, manifest.entrypoints.settings)),
  ]);
  validators.assertLayout(layout);
  validators.assertContent(content);
  validators.assertSchedule(schedule);
  validators.assertSettings(settings);
  return Object.freeze({ manifest, layout, content, schedule, settings });
};

export const readServerState = async (config) => {
  let fromDisk = {};
  try {
    fromDisk = await readJson(config.serverStateFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const adminUrl = config.publicUrl ?? fromDisk.adminUrl ?? null;
  return {
    serverReady: true,
    networkManagedExternally: true,
    serverIp: config.serverIp ?? fromDisk.serverIp ?? null,
    primaryHost: config.primaryHost ?? fromDisk.primaryHost ?? null,
    adminUrl,
    preferredAdminUrl: config.preferredUrl ?? fromDisk.preferredAdminUrl ?? adminUrl,
    fallbackAdminUrl: config.fallbackUrl ?? fromDisk.fallbackAdminUrl ?? null,
    apiUrl: config.apiUrl ?? fromDisk.apiUrl ?? (adminUrl ? `${adminUrl}/api` : null),
    softwareVersion: config.version,
  };
};

const personalizeLayout = (layout, { greeting }) => {
  const document = structuredClone(layout);
  const greetingNode = document.nodes.find(
    (node) => node.kind === 'text' && node.props?.role === 'greeting',
  );
  if (greetingNode) greetingNode.props.text = greeting;
  return document;
};

export const initializeEmptyInstance = async ({
  client,
  payload,
  user,
  server,
  experience,
}) => {
  const existing = await client.query('SELECT instance_id FROM roomframe_instance WHERE singleton = true FOR UPDATE');
  if (existing.rowCount > 0) {
    throw Object.assign(new Error('already_configured'), { statusCode: 409 });
  }
  const instanceId = crypto.randomUUID();
  const sceneId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const simulatorId = crypto.randomUUID();
  const scene = personalizeLayout(experience.layout, { greeting: payload.defaultGreeting });
  const sceneHash = sha256(canonicalize(scene));
  const instance = {
    schemaVersion: 2,
    instanceId,
    configuredAt: new Date().toISOString(),
    displayName: payload.displayName,
    server,
    branding: {
      primary: payload.branding.primary,
      accent: payload.branding.accent,
      logoAssetId: null,
      defaultGreeting: payload.defaultGreeting,
      defaultLogoPlacement: 'bottom-right',
    },
    defaults: {
      roomName: payload.roomName,
      experienceBundle: {
        bundleId: experience.manifest.bundleId,
        version: experience.manifest.version,
      },
      policies: payload.policies,
    },
  };

  await client.query(
    `INSERT INTO roomframe_instance (
       singleton, instance_id, display_name, configured_at, config
     ) VALUES (true, $1, $2, $3, $4)`,
    [instanceId, instance.displayName, instance.configuredAt, JSON.stringify(instance)],
  );
  await client.query(
    `INSERT INTO experience_seed_history (
       bundle_id, version, applied_to_empty_instance
     ) VALUES ($1, $2, true)
     ON CONFLICT (bundle_id, version) DO NOTHING`,
    [experience.manifest.bundleId, experience.manifest.version],
  );
  await client.query(
    `INSERT INTO scenes (id, name, current_revision, published_revision)
     VALUES ($1, $2, 1, 1)`,
    [sceneId, 'Accueil principal'],
  );
  await client.query(
    `INSERT INTO scene_revisions (
       scene_id, revision, document, sha256, change_summary, created_by, published_at
     ) VALUES ($1, 1, $2, $3, $4, $5, now())`,
    [sceneId, JSON.stringify(scene), sceneHash, 'Expérience initiale', user.id],
  );
  await client.query(
    `INSERT INTO scene_assignments (id, scene_id, target_type, target_id)
     VALUES ($1, $2, 'instance', NULL)`,
    [crypto.randomUUID(), sceneId],
  );
  await client.query(
    `INSERT INTO tv_groups (id, name, description)
     VALUES ($1, 'Toutes les salles', 'Groupe créé lors de la configuration initiale')`,
    [groupId],
  );
  await client.query(
    `INSERT INTO screens (
       id, device_key, display_name, room_name, group_id, layout_id,
       enrollment_state, active_revision, capabilities
     ) VALUES ($1, $2, 'Simulateur local', $3, $4, NULL, 'simulated', 1, $5)`,
    [
      simulatorId,
      sha256(crypto.randomBytes(32)),
      payload.roomName,
      groupId,
      JSON.stringify({
        simulated: true,
        hdmi: 'unsupported',
        cast: 'unsupported',
        airplay: 'unsupported',
        sleep: 'simulated',
        wake: 'unsupported',
      }),
    ],
  );
  for (const kind of ['airplay', 'cast', 'hdmi']) {
    await client.query(
      `INSERT INTO source_settings (
         id, target_type, target_id, source_kind, enabled, label, configuration
       ) VALUES ($1, 'instance', NULL, $2, true, $3, '{}'::jsonb)`,
      [crypto.randomUUID(), kind, kind === 'hdmi' ? 'HDMI' : kind[0].toUpperCase() + kind.slice(1)],
    );
  }
  await client.query(
    `INSERT INTO power_schedules (
       id, target_type, target_id, timezone, enabled, require_capability_probe, rules
     ) VALUES ($1, 'instance', NULL, $2, false, true, $3)`,
    [
      crypto.randomUUID(),
      experience.schedule.timezone,
      JSON.stringify(experience.schedule.power.rules),
    ],
  );
  for (const message of experience.content.feeds?.default ?? []) {
    await client.query(
      `INSERT INTO messages (
         id, title, body, priority, starts_at, ends_at, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        crypto.randomUUID(),
        String(message.title).slice(0, 200),
        String(message.body).slice(0, 2000),
        Number(message.priority ?? 0),
        message.startsAt,
        message.endsAt,
        user.id,
      ],
    );
  }
  return { instance, sceneId, simulatorId };
};
