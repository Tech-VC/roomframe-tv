import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  appendAudit,
  requireCsrf,
  requirePermission,
  requireSession,
  sessionFromRequest,
} from './auth.mjs';
import { canonicalize } from './canonical.mjs';
import { withTransaction } from './database.mjs';
import {
  ensureStorageCapacity,
  mediaVariantPath,
  selectMediaDeliveryVariants,
  storeMediaUpload,
  streamMediaVariant,
} from './media.mjs';
import {
  hasPermission,
  randomToken,
  sha256,
} from './security.mjs';
import {
  materializeVerifiedApkArtifacts,
  quarantineVerifiedUpdate,
  verifyUpdateBundle,
} from './update-verifier.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cleanText = (value, field, maximum, minimum = 1) => {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > maximum) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return text;
};

const optionalUuid = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (!uuidPattern.test(String(value))) throw Object.assign(new Error('invalid_uuid'), { statusCode: 400 });
  return String(value);
};

const brandColor = (value, field) => {
  const color = String(value ?? '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return color;
};

const targetIdFor = (targetType, value) => {
  if (targetType === 'instance' || targetType === 'fleet') return null;
  const id = optionalUuid(value);
  if (!id) throw Object.assign(new Error('target_id_required'), { statusCode: 400 });
  return id;
};

const integerInRange = (value, field, minimum, maximum, fallback = undefined) => {
  const candidate = value === undefined ? fallback : value;
  const number = Number(candidate);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`invalid_${field}`), { statusCode: 400 });
  }
  return number;
};

const optionalIntegerInRange = (value, field, minimum, maximum) => (
  value === undefined || value === null
    ? null
    : integerInRange(value, field, minimum, maximum)
);

const sourceConfiguration = (kind, value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('invalid_source_configuration'), { statusCode: 400 });
  }
  const permitted = {
    airplay: new Set(['adapter', 'serviceName', 'receiverMode', 'returnHomeWhenInactiveMinutes']),
    cast: new Set(['adapter', 'receiverApplicationId', 'returnHomeWhenInactiveMinutes']),
    hdmi: new Set(['adapter', 'physicalInput', 'signalProbe', 'returnHomeWhenInactiveMinutes']),
    'private-app': new Set(['adapter', 'applicationId', 'activity', 'returnPolicy']),
  }[kind];
  const clean = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!permitted.has(key)) {
      throw Object.assign(new Error('unsupported_source_configuration_key'), { statusCode: 400 });
    }
    if (typeof raw === 'boolean') {
      clean[key] = raw;
    } else if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
      clean[key] = raw;
    } else if (typeof raw === 'string' && raw.length <= 300 && !/[\u0000-\u001f\u007f]/.test(raw)) {
      clean[key] = raw;
    } else {
      throw Object.assign(new Error('invalid_source_configuration_value'), { statusCode: 400 });
    }
  }
  if (
    clean.applicationId !== undefined
    && !/^[A-Za-z][A-Za-z0-9_.]{2,199}$/.test(clean.applicationId)
  ) {
    throw Object.assign(new Error('invalid_application_id'), { statusCode: 400 });
  }
  if (
    clean.physicalInput !== undefined
    && !/^HDMI[1-8]$/.test(clean.physicalInput)
  ) {
    throw Object.assign(new Error('invalid_physical_input'), { statusCode: 400 });
  }
  if (clean.returnHomeWhenInactiveMinutes !== undefined) {
    clean.returnHomeWhenInactiveMinutes = integerInRange(
      clean.returnHomeWhenInactiveMinutes,
      'return_home_minutes',
      1,
      1440,
    );
  }
  return clean;
};

const controlledEventPayload = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('invalid_event_payload'), { statusCode: 400 });
  }
  const allowed = new Set([
    'adapter',
    'source',
    'sourceKind',
    'signal',
    'state',
    'phase',
    'code',
    'version',
    'revision',
    'durationMs',
    'recoverable',
    'capability',
    'reason',
  ]);
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw Object.assign(new Error('unsupported_event_payload_key'), { statusCode: 400 });
    }
    if (typeof raw === 'boolean' || raw === null) {
      result[key] = raw;
    } else if (typeof raw === 'number' && Number.isSafeInteger(raw) && Math.abs(raw) <= Number.MAX_SAFE_INTEGER) {
      result[key] = raw;
    } else if (
      typeof raw === 'string'
      && raw.length <= 160
      && !/[\u0000-\u001f\u007f]/.test(raw)
    ) {
      result[key] = raw;
    } else {
      throw Object.assign(new Error('invalid_event_payload_value'), { statusCode: 400 });
    }
  }
  return result;
};

const defaultAssetMime = (file) => ({
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}[path.extname(file).toLowerCase()] ?? 'application/octet-stream');

const bumpSyncRevision = (client) => client.query(
  'UPDATE sync_state SET revision = revision + 1, updated_at = now() WHERE singleton = true RETURNING revision',
);

const variantUrls = (asset) => Object.fromEntries(
  Object.entries(asset.variants ?? {}).map(([name, descriptor]) => [
    name,
    {
      ...descriptor,
      url: `/api/v1/media/${asset.id}/${name}`,
      path: undefined,
    },
  ]),
);

const serializeAsset = (asset) => ({
  id: asset.id,
  sha256: asset.sha256,
  kind: asset.media_type,
  originalMediaType: asset.original_media_type,
  originalFilename: asset.original_filename,
  byteSize: Number(asset.byte_size ?? 0),
  status: asset.processing_status,
  width: asset.width,
  height: asset.height,
  durationMs: asset.duration_ms === null ? null : Number(asset.duration_ms),
  focalX: Number(asset.focal_x ?? 0.5),
  focalY: Number(asset.focal_y ?? 0.5),
  variants: variantUrls(asset),
  logoTransparency: asset.metadata?.logoTransparency ?? null,
  createdAt: asset.created_at,
});

const serializeRelease = (release) => ({
  ...release,
  verification: {
    ...(release.verification ?? {}),
    apkArtifacts: (release.verification?.apkArtifacts ?? []).map(
      ({ storagePath: _storagePath, ...artifact }) => artifact,
    ),
  },
});

const saveUpload = async (part, target, maximum) => {
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximum) {
        callback(Object.assign(new Error('upload_too_large'), { statusCode: 413 }));
      } else {
        callback(null, chunk);
      }
    },
  });
  await pipeline(part.file, meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  if (part.file.truncated) throw Object.assign(new Error('upload_too_large'), { statusCode: 413 });
  return bytes;
};

const writeAudit = (client, request, action, targetType, targetId, details = {}) => appendAudit(client, {
  session: request.roomframeSession,
  action,
  targetType,
  targetId,
  remoteAddress: request.ip,
  details,
});

const resolveScreen = async ({
  request,
  pool,
  config,
  sessionPermission,
}) => {
  const session = await sessionFromRequest(request, pool, config);
  const requestedId = String(
    request.query?.deviceId
    ?? request.headers['x-roomframe-device-id']
    ?? '',
  );
  if (session) {
    if (sessionPermission && !hasPermission(session.permissions, sessionPermission)) {
      throw Object.assign(new Error('permission_denied'), { statusCode: 403 });
    }
    const result = requestedId === 'simulator' || requestedId === ''
      ? await pool.query(
        "SELECT * FROM screens WHERE enrollment_state = 'simulated' ORDER BY created_at LIMIT 1",
      )
      : await pool.query('SELECT * FROM screens WHERE id = $1', [optionalUuid(requestedId)]);
    if (!result.rows[0]) throw Object.assign(new Error('tv_not_found'), { statusCode: 404 });
    return { screen: result.rows[0], session };
  }
  const deviceKey = request.headers['x-roomframe-device-key'];
  if (typeof deviceKey !== 'string' || deviceKey.length < 20 || !uuidPattern.test(requestedId)) {
    throw Object.assign(new Error('tv_authentication_required'), { statusCode: 401 });
  }
  const result = await pool.query(
    "SELECT * FROM screens WHERE id = $1 AND device_key = $2 AND enrollment_state = 'active'",
    [requestedId, sha256(deviceKey)],
  );
  if (!result.rows[0]) throw Object.assign(new Error('invalid_tv_credentials'), { statusCode: 401 });
  return { screen: result.rows[0], session: null };
};

const sceneForScreen = async (pool, screen) => {
  const assigned = await pool.query(
    `SELECT scene_id
     FROM scene_assignments
     WHERE
       (target_type = 'tv' AND target_id = $1)
       OR (target_type = 'group' AND target_id = $2)
       OR (target_type = 'instance' AND target_id IS NULL)
     ORDER BY CASE target_type WHEN 'tv' THEN 1 WHEN 'group' THEN 2 ELSE 3 END
     LIMIT 1`,
    [screen.id, screen.group_id],
  );
  if (!assigned.rows[0]) throw Object.assign(new Error('scene_not_assigned'), { statusCode: 404 });
  const scene = await pool.query(
    `SELECT s.id, s.name, s.published_revision, r.document, r.sha256, r.published_at
     FROM scenes s
     JOIN scene_revisions r
       ON r.scene_id = s.id AND r.revision = s.published_revision
     WHERE s.id = $1`,
    [assigned.rows[0].scene_id],
  );
  if (!scene.rows[0]) throw Object.assign(new Error('scene_not_published'), { statusCode: 409 });
  return scene.rows[0];
};

const referencedAssetUsages = (scene) => {
  const usages = new Map();
  const add = (value, usage) => {
    if (typeof value !== 'string' || !uuidPattern.test(value)) return;
    if (!usages.has(value)) usages.set(value, new Set());
    usages.get(value).add(usage);
  };
  add(scene.canvas?.background?.assetId, 'content');
  add(scene.canvas?.background?.asset, 'content');
  for (const node of scene.nodes ?? []) {
    add(node.props?.assetId, node.kind === 'logo' ? 'logo' : 'content');
    add(node.props?.iconAssetId, 'content');
  }
  return usages;
};

const referencedAssetIds = (scene) => [...referencedAssetUsages(scene).keys()];

const referencedDefaultAssets = (scene) => {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('assets/')) paths.add(value);
  };
  add(scene.canvas?.background?.asset);
  for (const node of scene.nodes ?? []) {
    add(node.props?.asset);
  }
  return paths;
};

const validPublishedVariant = (descriptor) => (
  descriptor
  && typeof descriptor === 'object'
  && /^[a-f0-9]{64}$/.test(String(descriptor.sha256 ?? ''))
  && Number.isSafeInteger(Number(descriptor.size))
  && Number(descriptor.size) > 0
  && typeof descriptor.mime === 'string'
  && descriptor.mime.length > 0
  && typeof descriptor.path === 'string'
  && descriptor.path.length > 0
);

const assertSceneAssetsAvailable = async (queryable, scene, experience, errorCode) => {
  const assetUsages = referencedAssetUsages(scene);
  const assetIds = [...assetUsages.keys()];
  const uploadedAssets = assetIds.length === 0
    ? []
    : (await queryable.query(
      'SELECT * FROM assets WHERE id = ANY($1::uuid[])',
      [assetIds],
    )).rows;
  const byId = new Map(uploadedAssets.map((asset) => [asset.id, asset]));
  const unavailable = assetIds.filter((id) => {
    const asset = byId.get(id);
    const deliveryVariants = selectMediaDeliveryVariants(asset, assetUsages.get(id))
      .map(([, descriptor]) => descriptor);
    return (
      !asset
      || asset.processing_status !== 'ready'
      || !/^[a-f0-9]{64}$/.test(String(asset.sha256 ?? ''))
      || deliveryVariants.length === 0
      || !deliveryVariants.every(validPublishedVariant)
    );
  });
  const knownDefaults = new Set(
    experience.manifest.files
      .filter((entry) => /^[a-f0-9]{64}$/.test(String(entry.sha256 ?? '')))
      .map((entry) => entry.path),
  );
  const missingDefaults = [...referencedDefaultAssets(scene)]
    .filter((entryPath) => !knownDefaults.has(entryPath));
  if (unavailable.length > 0 || missingDefaults.length > 0) {
    throw Object.assign(new Error(errorCode), {
      statusCode: 409,
      unavailableAssetIds: unavailable,
      missingDefaultAssets: missingDefaults,
    });
  }
  return uploadedAssets;
};

const jsonDocument = (pathName, value) => {
  const body = canonicalize(value);
  return {
    path: pathName,
    sha256: sha256(body),
    size: Buffer.byteLength(body),
  };
};

export const registerStudioRoutes = ({
  app,
  pool,
  config,
  validators,
  experience,
}) => {
  const authenticated = requireSession(pool, config);
  const csrf = requireCsrf(config);

  app.get('/api/v1/instance', {
    preHandler: [authenticated, requirePermission('instance:read')],
  }, async (_request, reply) => {
    const result = await pool.query('SELECT config FROM roomframe_instance WHERE singleton = true');
    if (!result.rows[0]) return reply.code(404).send({ error: 'instance_not_configured' });
    return result.rows[0].config;
  });

  app.put('/api/v1/instance/branding', {
    preHandler: [authenticated, requirePermission('instance:write'), csrf],
  }, async (request) => withTransaction(pool, async (client) => {
    const currentResult = await client.query(
      'SELECT config FROM roomframe_instance WHERE singleton = true FOR UPDATE',
    );
    const current = currentResult.rows[0]?.config;
    if (!current) throw Object.assign(new Error('instance_not_configured'), { statusCode: 409 });
    const requested = request.body?.branding ?? {};
    const fontPreset = String(requested.fontPreset ?? 'studio');
    if (!['studio', 'compact', 'humanist'].includes(fontPreset)) {
      throw Object.assign(new Error('invalid_font_preset'), { statusCode: 400 });
    }
    const logoAssetId = optionalUuid(requested.logoAssetId);
    if (logoAssetId) {
      const asset = await client.query(
        "SELECT id FROM assets WHERE id = $1 AND media_type = 'image' AND processing_status = 'ready'",
        [logoAssetId],
      );
      if (!asset.rows[0]) {
        throw Object.assign(new Error('branding_logo_not_ready'), { statusCode: 409 });
      }
    }
    const displayName = cleanText(request.body?.displayName, 'display_name', 100);
    const next = {
      ...current,
      displayName,
      branding: {
        ...current.branding,
        primary: brandColor(requested.primary, 'primary_color'),
        accent: brandColor(requested.accent, 'accent_color'),
        surface: brandColor(requested.surface, 'surface_color'),
        ink: brandColor(requested.ink, 'ink_color'),
        muted: brandColor(requested.muted, 'muted_color'),
        fontPreset,
        logoAssetId,
      },
    };
    validators.assertInstance(next);
    await client.query(
      `UPDATE roomframe_instance
       SET display_name = $1, config = $2
       WHERE singleton = true`,
      [displayName, JSON.stringify(next)],
    );
    const sync = await bumpSyncRevision(client);
    await writeAudit(client, request, 'instance.branding.updated', 'instance', current.instanceId, {
      displayName,
      fontPreset,
      logoAssetId,
      syncRevision: Number(sync.rows[0].revision),
    });
    return { instance: next, syncRevision: Number(sync.rows[0].revision) };
  }));

  app.get('/api/v1/studio', {
    preHandler: [authenticated, requirePermission('studio:read')],
  }, async (request) => {
    const [
      instanceResult,
      sceneResult,
      revisionsResult,
      assetsResult,
      screensResult,
      groupsResult,
      messagesResult,
      sourcesResult,
      powerResult,
      releasesResult,
      deploymentsResult,
      syncResult,
    ] = await Promise.all([
      pool.query('SELECT config FROM roomframe_instance WHERE singleton = true'),
      pool.query(
        `SELECT s.*, r.document
         FROM scenes s
         JOIN scene_revisions r ON r.scene_id = s.id AND r.revision = s.current_revision
         ORDER BY s.created_at LIMIT 1`,
      ),
      pool.query(
        `SELECT scene_id, revision, sha256, change_summary, created_at, published_at
         FROM scene_revisions ORDER BY created_at DESC LIMIT 100`,
      ),
      pool.query('SELECT * FROM assets ORDER BY created_at DESC LIMIT 200'),
      pool.query(
        `SELECT id, display_name, room_name, group_id, enrollment_state, agent_version,
                home_version, active_revision, capabilities, source_state, last_seen_at,
                enrollment_expires_at
         FROM screens ORDER BY display_name`,
      ),
      pool.query('SELECT * FROM tv_groups ORDER BY name'),
      pool.query('SELECT * FROM messages ORDER BY priority DESC, created_at DESC LIMIT 200'),
      pool.query('SELECT * FROM source_settings ORDER BY source_kind'),
      pool.query('SELECT * FROM power_schedules ORDER BY created_at'),
      pool.query(
        `SELECT id, version, status, signature_key_id, verification, imported_at, deployed_at
         FROM release_history ORDER BY imported_at DESC LIMIT 100`,
      ),
      pool.query('SELECT * FROM deployments ORDER BY created_at DESC LIMIT 100'),
      pool.query('SELECT revision, updated_at FROM sync_state WHERE singleton = true'),
    ]);
    if (!instanceResult.rows[0]) throw Object.assign(new Error('instance_not_configured'), { statusCode: 409 });
    const scene = sceneResult.rows[0] ?? null;
    const can = (permission) => hasPermission(
      request.roomframeSession.permissions,
      permission,
    );
    return {
      instance: instanceResult.rows[0].config,
      scene: scene ? {
        id: scene.id,
        name: scene.name,
        currentRevision: Number(scene.current_revision),
        publishedRevision: scene.published_revision === null ? null : Number(scene.published_revision),
        document: scene.document,
      } : null,
      revisions: revisionsResult.rows.map((row) => ({
        ...row,
        revision: Number(row.revision),
      })),
      media: can('media:read') ? assetsResult.rows.map(serializeAsset) : [],
      tvs: can('fleet:read') ? screensResult.rows.map((row) => ({
        ...row,
        active_revision: row.active_revision === null ? null : Number(row.active_revision),
      })) : [],
      groups: can('fleet:read') ? groupsResult.rows : [],
      messages: can('messages:read') ? messagesResult.rows : [],
      sourceSettings: can('fleet:read') ? sourcesResult.rows : [],
      powerSchedules: can('fleet:read') ? powerResult.rows : [],
      releases: can('releases:read') ? releasesResult.rows.map(serializeRelease) : [],
      deployments: can('releases:read') ? deploymentsResult.rows : [],
      syncRevision: Number(syncResult.rows[0]?.revision ?? 1),
      measuredMetrics: null,
    };
  });

  app.post('/api/v1/scenes/:sceneId/revisions', {
    preHandler: [authenticated, requirePermission('studio:write'), csrf],
  }, async (request, reply) => {
    const sceneId = optionalUuid(request.params.sceneId);
    const document = request.body?.scene ?? request.body?.document;
    validators.assertLayout(document);
    const baseRevision = Number(request.body?.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw Object.assign(new Error('invalid_base_revision'), { statusCode: 400 });
    }
    const result = await withTransaction(pool, async (client) => {
      const locked = await client.query('SELECT * FROM scenes WHERE id = $1 FOR UPDATE', [sceneId]);
      const scene = locked.rows[0];
      if (!scene) throw Object.assign(new Error('scene_not_found'), { statusCode: 404 });
      if (Number(scene.current_revision) !== baseRevision) {
        throw Object.assign(new Error('scene_revision_conflict'), {
          statusCode: 409,
          currentRevision: Number(scene.current_revision),
        });
      }
      const revision = baseRevision + 1;
      const digest = sha256(canonicalize(document));
      await client.query(
        `INSERT INTO scene_revisions (
           scene_id, revision, document, sha256, change_summary, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sceneId,
          revision,
          JSON.stringify(document),
          digest,
          cleanText(request.body?.changeSummary ?? 'Brouillon studio', 'change_summary', 300),
          request.roomframeSession.user_id,
        ],
      );
      await client.query(
        'UPDATE scenes SET current_revision = $2, updated_at = now() WHERE id = $1',
        [sceneId, revision],
      );
      await writeAudit(client, request, 'scene.revision.created', 'scene', sceneId, { revision });
      return { revision, sha256: digest };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/scenes/:sceneId/publish', {
    preHandler: [authenticated, requirePermission('studio:write'), csrf],
  }, async (request) => {
    const sceneId = optionalUuid(request.params.sceneId);
    const revision = Number(request.body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw Object.assign(new Error('invalid_revision'), { statusCode: 400 });
    }
    return withTransaction(pool, async (client) => {
      const locked = await client.query('SELECT * FROM scenes WHERE id = $1 FOR UPDATE', [sceneId]);
      if (!locked.rows[0]) throw Object.assign(new Error('scene_not_found'), { statusCode: 404 });
      const candidate = await client.query(
        'SELECT document, sha256 FROM scene_revisions WHERE scene_id = $1 AND revision = $2',
        [sceneId, revision],
      );
      if (!candidate.rows[0]) throw Object.assign(new Error('scene_revision_not_found'), { statusCode: 404 });
      await assertSceneAssetsAvailable(
        client,
        candidate.rows[0].document,
        experience,
        'scene_assets_not_ready',
      );
      await client.query(
        `UPDATE scenes
         SET published_revision = $2, updated_at = now()
         WHERE id = $1`,
        [sceneId, revision],
      );
      await client.query(
        `UPDATE scene_revisions
         SET published_at = COALESCE(published_at, now())
         WHERE scene_id = $1 AND revision = $2`,
        [sceneId, revision],
      );
      const sync = await bumpSyncRevision(client);
      await writeAudit(client, request, 'scene.published', 'scene', sceneId, {
        revision,
        syncRevision: Number(sync.rows[0].revision),
      });
      return {
        published: true,
        revision,
        syncRevision: Number(sync.rows[0].revision),
        sha256: candidate.rows[0].sha256,
      };
    });
  });

  app.get('/api/v1/media', {
    preHandler: [authenticated, requirePermission('media:read')],
  }, async () => {
    const result = await pool.query('SELECT * FROM assets ORDER BY created_at DESC LIMIT 500');
    return { media: result.rows.map(serializeAsset) };
  });

  app.post('/api/v1/media', {
    preHandler: [authenticated, requirePermission('media:write'), csrf],
  }, async (request, reply) => {
    const part = await request.file({
      limits: { fileSize: config.maxVideoBytes, files: 1, fields: 4 },
    });
    if (!part || part.fieldname !== 'file') {
      throw Object.assign(new Error('media_file_required'), { statusCode: 400 });
    }
    const asset = await storeMediaUpload({
      part,
      config,
      pool,
      userId: request.roomframeSession.user_id,
      declaredBytes: Number(request.headers['content-length']) || null,
    });
    await appendAudit(pool, {
      session: request.roomframeSession,
      action: 'media.uploaded',
      targetType: 'media',
      targetId: asset.id,
      remoteAddress: request.ip,
      details: { sha256: asset.sha256, kind: asset.media_type },
    });
    return reply.code(asset.processing_status === 'ready' ? 200 : 202).send(serializeAsset(asset));
  });

  app.patch('/api/v1/media/:assetId', {
    preHandler: [authenticated, requirePermission('media:write'), csrf],
  }, async (request) => {
    const assetId = optionalUuid(request.params.assetId);
    const focalX = Number(request.body?.focalX);
    const focalY = Number(request.body?.focalY);
    if (
      !Number.isFinite(focalX) || focalX < 0 || focalX > 1
      || !Number.isFinite(focalY) || focalY < 0 || focalY > 1
    ) {
      throw Object.assign(new Error('invalid_focal_point'), { statusCode: 400 });
    }
    return withTransaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE assets SET focal_x = $2, focal_y = $3
         WHERE id = $1 RETURNING *`,
        [assetId, focalX, focalY],
      );
      if (!updated.rows[0]) throw Object.assign(new Error('media_not_found'), { statusCode: 404 });
      await bumpSyncRevision(client);
      await writeAudit(client, request, 'media.focal-point.updated', 'media', assetId, {
        focalX,
        focalY,
      });
      return serializeAsset(updated.rows[0]);
    });
  });

  app.get('/api/v1/media/:assetId/:variant', async (request, reply) => {
    const { screen, session } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'media:read',
    });
    const assetId = optionalUuid(request.params.assetId);
    if (!session) {
      const assignedScene = await sceneForScreen(pool, screen);
      if (!referencedAssetIds(assignedScene.document).includes(assetId)) {
        return reply.code(404).send({ error: 'media_not_found' });
      }
    }
    const result = await pool.query('SELECT * FROM assets WHERE id = $1 AND processing_status = $2', [
      assetId,
      'ready',
    ]);
    const asset = result.rows[0];
    if (!asset) return reply.code(404).send({ error: 'media_not_found' });
    const file = await mediaVariantPath(config, asset, request.params.variant).catch(() => null);
    if (!file) return reply.code(404).send({ error: 'media_variant_not_found' });
    return streamMediaVariant(reply, file, asset.variants[request.params.variant].mime);
  });

  app.post('/api/v1/messages', {
    preHandler: [authenticated, requirePermission('messages:write'), csrf],
  }, async (request, reply) => {
    const startsAt = request.body?.startsAt ? new Date(request.body.startsAt) : null;
    const endsAt = request.body?.endsAt ? new Date(request.body.endsAt) : null;
    if (
      (startsAt && Number.isNaN(startsAt.getTime()))
      || (endsAt && Number.isNaN(endsAt.getTime()))
      || (startsAt && endsAt && endsAt <= startsAt)
    ) {
      throw Object.assign(new Error('invalid_message_schedule'), { statusCode: 400 });
    }
    const targetType = request.body?.targetType ?? 'instance';
    if (!['instance', 'group', 'tv'].includes(targetType)) {
      throw Object.assign(new Error('invalid_target_type'), { statusCode: 400 });
    }
    const targetId = targetIdFor(targetType, request.body?.targetId);
    const priority = integerInRange(request.body?.priority, 'message_priority', -100, 100, 0);
    const id = crypto.randomUUID();
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO messages (
           id, title, body, priority, starts_at, ends_at, target_type, target_id, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          cleanText(request.body?.title, 'message_title', 200),
          cleanText(request.body?.body, 'message_body', 2000),
          priority,
          startsAt,
          endsAt,
          targetType,
          targetId,
          request.roomframeSession.user_id,
        ],
      );
      await bumpSyncRevision(client);
      await writeAudit(client, request, 'message.created', 'message', id);
    });
    return reply.code(201).send({ id });
  });

  app.get('/api/v1/tvs', {
    preHandler: [authenticated, requirePermission('fleet:read')],
  }, async () => {
    const result = await pool.query(
      `SELECT id, display_name, room_name, group_id, enrollment_state, agent_version,
              home_version, active_revision, capabilities, source_state, last_seen_at,
              enrollment_expires_at
       FROM screens ORDER BY display_name`,
    );
    return { tvs: result.rows };
  });

  app.post('/api/v1/tvs/enrollment', {
    preHandler: [authenticated, requirePermission('fleet:write'), csrf],
  }, async (request, reply) => {
    const id = crypto.randomUUID();
    const enrollmentKey = randomToken(32);
    const groupId = optionalUuid(request.body?.groupId);
    const enrollmentExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO screens (
           id, device_key, display_name, room_name, group_id, enrollment_state,
           enrollment_expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [
          id,
          sha256(enrollmentKey),
          cleanText(request.body?.displayName, 'tv_display_name', 100),
          cleanText(request.body?.roomName, 'room_name', 100),
          groupId,
          enrollmentExpiresAt,
        ],
      );
      await writeAudit(client, request, 'tv.enrollment.created', 'tv', id);
    });
    return reply.code(201).send({
      id,
      enrollmentKey,
      expiresAt: enrollmentExpiresAt.toISOString(),
      expiresNote: 'À remettre une seule fois à la TV pendant un enrôlement local contrôlé.',
    });
  });

  app.post('/api/v1/tv/enroll', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const deviceId = optionalUuid(request.body?.deviceId);
    const enrollmentKey = String(request.body?.enrollmentKey ?? '');
    if (!deviceId || enrollmentKey.length < 20 || enrollmentKey.length > 200) {
      throw Object.assign(new Error('invalid_enrollment_credentials'), { statusCode: 401 });
    }
    const deviceKey = randomToken(32);
    const enrolled = await withTransaction(pool, async (client) => {
      const pending = await client.query(
        `SELECT id
         FROM screens
         WHERE id = $1
           AND device_key = $2
           AND enrollment_state = 'pending'
           AND enrollment_expires_at > now()
         FOR UPDATE`,
        [deviceId, sha256(enrollmentKey)],
      );
      if (!pending.rows[0]) {
        throw Object.assign(new Error('invalid_enrollment_credentials'), { statusCode: 401 });
      }
      const updated = await client.query(
        `UPDATE screens
         SET device_key = $2, enrollment_state = 'active',
             enrollment_expires_at = NULL, device_key_rotated_at = now(),
             last_seen_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING id, display_name, room_name`,
        [deviceId, sha256(deviceKey)],
      );
      await appendAudit(client, {
        actorType: 'tv',
        action: 'tv.enrolled',
        targetType: 'tv',
        targetId: deviceId,
        remoteAddress: request.ip,
      });
      return updated.rows[0];
    });
    return reply.code(201).send({
      device: enrolled,
      deviceKey,
      apiUrl: config.apiUrl,
      credentialDelivery: 'one-time',
    });
  });

  app.get('/api/v1/groups', {
    preHandler: [authenticated, requirePermission('fleet:read')],
  }, async () => {
    const result = await pool.query('SELECT * FROM tv_groups ORDER BY name');
    return { groups: result.rows };
  });

  app.post('/api/v1/groups', {
    preHandler: [authenticated, requirePermission('fleet:write'), csrf],
  }, async (request, reply) => {
    const id = crypto.randomUUID();
    await withTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO tv_groups (id, name, description) VALUES ($1, $2, $3)',
        [
          id,
          cleanText(request.body?.name, 'group_name', 100),
          request.body?.description
            ? cleanText(request.body.description, 'group_description', 500)
            : null,
        ],
      );
      await writeAudit(client, request, 'group.created', 'group', id);
    });
    return reply.code(201).send({ id });
  });

  app.put('/api/v1/settings/sources/:kind', {
    preHandler: [authenticated, requirePermission('fleet:write'), csrf],
  }, async (request) => {
    const kind = request.params.kind;
    if (!['airplay', 'cast', 'hdmi', 'private-app'].includes(kind)) {
      throw Object.assign(new Error('invalid_source_kind'), { statusCode: 400 });
    }
    const targetType = request.body?.targetType ?? 'instance';
    if (!['instance', 'group', 'tv'].includes(targetType)) {
      throw Object.assign(new Error('invalid_target_type'), { statusCode: 400 });
    }
    const targetId = targetIdFor(targetType, request.body?.targetId);
    const configuration = sourceConfiguration(kind, request.body?.configuration ?? {});
    await withTransaction(pool, async (client) => {
      await client.query(
        'DELETE FROM source_settings WHERE target_type = $1 AND target_id IS NOT DISTINCT FROM $2 AND source_kind = $3',
        [targetType, targetId, kind],
      );
      await client.query(
        `INSERT INTO source_settings (
           id, target_type, target_id, source_kind, enabled, label, configuration
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          targetType,
          targetId,
          kind,
          request.body?.enabled !== false,
          cleanText(request.body?.label ?? kind, 'source_label', 100),
          JSON.stringify(configuration),
        ],
      );
      await bumpSyncRevision(client);
      await writeAudit(client, request, 'source.updated', 'source', kind, { targetType, targetId });
    });
    return { updated: true };
  });

  app.put('/api/v1/settings/power', {
    preHandler: [authenticated, requirePermission('fleet:write'), csrf],
  }, async (request) => {
    const targetType = request.body?.targetType ?? 'instance';
    if (!['instance', 'group', 'tv'].includes(targetType)) {
      throw Object.assign(new Error('invalid_target_type'), { statusCode: 400 });
    }
    const targetId = targetIdFor(targetType, request.body?.targetId);
    const schedule = {
      schemaVersion: 2,
      timezone: cleanText(request.body?.timezone ?? 'Europe/Paris', 'timezone', 100),
      sourcePolicies: {
        returnHomeWhenInactiveMinutes: Number(request.body?.returnHomeWhenInactiveMinutes ?? 15),
        homeSleepMinutes: Number(request.body?.homeSleepMinutes ?? 30),
      },
      power: {
        enabled: Boolean(request.body?.enabled),
        requireCapabilityProbe: true,
        rules: request.body?.rules ?? [],
      },
    };
    validators.assertSchedule(schedule);
    await withTransaction(pool, async (client) => {
      await client.query(
        'DELETE FROM power_schedules WHERE target_type = $1 AND target_id IS NOT DISTINCT FROM $2',
        [targetType, targetId],
      );
      await client.query(
        `INSERT INTO power_schedules (
           id, target_type, target_id, timezone, enabled, require_capability_probe, rules
         ) VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          crypto.randomUUID(),
          targetType,
          targetId,
          schedule.timezone,
          schedule.power.enabled,
          JSON.stringify(schedule.power.rules),
        ],
      );
      await bumpSyncRevision(client);
      await writeAudit(client, request, 'power.updated', 'power', targetType, { targetId });
    });
    return { updated: true, capabilityProbeRequired: true };
  });

  app.get('/api/v1/users', {
    preHandler: [authenticated, requirePermission('users:read')],
  }, async () => {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.active, u.created_at, u.updated_at, r.slug AS role
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username`,
    );
    return { users: result.rows };
  });

  app.get('/api/v1/roles', {
    preHandler: [authenticated, requirePermission('users:read')],
  }, async () => {
    const result = await pool.query('SELECT id, slug, display_name, permissions FROM roles ORDER BY slug');
    return { roles: result.rows };
  });

  app.get('/api/v1/audit', {
    preHandler: [authenticated, requirePermission('audit:read')],
  }, async () => {
    const result = await pool.query(
      `SELECT id, actor_user_id, actor_type, action, target_type, target_id,
              remote_address, details, created_at
       FROM audit_log ORDER BY id DESC LIMIT 500`,
    );
    return { events: result.rows };
  });

  app.get('/api/v1/releases', {
    preHandler: [authenticated, requirePermission('releases:read')],
  }, async () => {
    const [releases, deployments] = await Promise.all([
      pool.query(
        `SELECT id, version, status, signature_key_id, verification, imported_at, deployed_at
         FROM release_history ORDER BY imported_at DESC LIMIT 100`,
      ),
      pool.query('SELECT * FROM deployments ORDER BY created_at DESC LIMIT 100'),
    ]);
    return { releases: releases.rows.map(serializeRelease), deployments: deployments.rows };
  });

  app.post('/api/v1/releases/import', {
    preHandler: [authenticated, requirePermission('releases:write'), csrf],
  }, async (request, reply) => {
    const part = await request.file({
      limits: { fileSize: config.maxUpdateBytes, files: 1, fields: 2 },
    });
    if (!part || part.fieldname !== 'file' || path.extname(part.filename ?? '').toLowerCase() !== '.rfupdate') {
      throw Object.assign(new Error('rfupdate_file_required'), { statusCode: 400 });
    }
    await mkdir(config.processingDir, { recursive: true, mode: 0o700 });
    await ensureStorageCapacity(
      config.processingDir,
      Math.min(
        Number(request.headers['content-length']) || config.maxUpdateBytes,
        config.maxUpdateBytes,
      ),
      config.storageReserveBytes,
    );
    const temporary = path.join(config.processingDir, `release-${crypto.randomUUID()}.rfupdate.part`);
    try {
      await saveUpload(part, temporary, config.maxUpdateBytes);
      const verified = await verifyUpdateBundle({
        file: temporary,
        validators,
        trustDir: config.updateTrustDir,
        currentVersion: config.version,
      });
      const destination = await quarantineVerifiedUpdate({
        source: temporary,
        releasesDir: config.releasesDir,
        bundleSha256: verified.bundleSha256,
      });
      const apkArtifacts = await materializeVerifiedApkArtifacts({
        bundleFile: destination,
        manifest: verified.manifest,
        releasesDir: config.releasesDir,
      });
      await withTransaction(pool, async (client) => {
        await client.query(
          `INSERT INTO release_history (
             id, version, manifest, status, sha256, signature_key_id,
             verification, storage_path, created_by
           ) VALUES ($1, $2, $3, 'verified', $4, $5, $6, $7, $8)`,
          [
            verified.manifest.releaseId,
            verified.manifest.version,
            JSON.stringify(verified.manifest),
            verified.bundleSha256,
            verified.signatureKeyId,
            JSON.stringify({
              signature: 'valid',
              hashes: 'valid',
              compatibility: 'valid',
              dataPreservation: true,
              apkArtifacts,
            }),
            destination,
            request.roomframeSession.user_id,
          ],
        );
        await writeAudit(
          client,
          request,
          'release.imported',
          'release',
          verified.manifest.releaseId,
          { version: verified.manifest.version, sha256: verified.bundleSha256 },
        );
      });
      return reply.code(201).send({
        releaseId: verified.manifest.releaseId,
        version: verified.manifest.version,
        status: 'verified',
        signatureKeyId: verified.signatureKeyId,
        bundleSha256: verified.bundleSha256,
        apkArtifacts: apkArtifacts.map((artifact) => ({
          kind: artifact.kind,
          packageName: artifact.packageName,
          versionCode: artifact.versionCode,
          sha256: artifact.sha256,
          size: artifact.size,
          signingCertificateSha256: artifact.signingCertificateSha256,
        })),
        nextStep: 'Planifier explicitement une vague canari. Aucun artefact n’a été exécuté.',
      });
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });

  app.post('/api/v1/releases/:releaseId/deployments', {
    preHandler: [authenticated, requirePermission('deployments:write'), csrf],
  }, async (request, reply) => {
    const releaseId = optionalUuid(request.params.releaseId);
    const strategy = request.body?.strategy ?? 'canary';
    if (!['canary', 'progressive'].includes(strategy)) {
      throw Object.assign(new Error('invalid_deployment_strategy'), { statusCode: 400 });
    }
    const targetType = request.body?.targetType ?? (strategy === 'canary' ? 'tv' : 'group');
    if (!['tv', 'group', 'fleet'].includes(targetType)) {
      throw Object.assign(new Error('invalid_target_type'), { statusCode: 400 });
    }
    if (strategy === 'canary' && targetType !== 'tv') {
      throw Object.assign(new Error('canary_requires_tv_target'), { statusCode: 400 });
    }
    const targetId = targetIdFor(targetType, request.body?.targetId);
    const batchSize = integerInRange(request.body?.batchSize, 'batch_size', 1, 100, 1);
    const id = crypto.randomUUID();
    const planned = await withTransaction(pool, async (client) => {
      const release = await client.query(
        "SELECT id, manifest FROM release_history WHERE id = $1 AND status = 'verified'",
        [releaseId],
      );
      if (!release.rows[0]) throw Object.assign(new Error('verified_release_not_found'), { statusCode: 404 });
      if (!(release.rows[0].manifest?.artifacts ?? []).some((artifact) => artifact.kind === 'home-apk')) {
        throw Object.assign(new Error('home_apk_artifact_required'), { statusCode: 409 });
      }
      const targets = targetType === 'tv'
        ? await client.query(
          "SELECT id FROM screens WHERE id = $1 AND enrollment_state = 'active'",
          [targetId],
        )
        : targetType === 'group'
          ? await client.query(
            `SELECT id FROM screens
             WHERE group_id = $1 AND enrollment_state = 'active'
             ORDER BY display_name, id`,
            [targetId],
          )
          : await client.query(
            `SELECT id FROM screens
             WHERE enrollment_state = 'active'
             ORDER BY display_name, id`,
          );
      const screenIds = targets.rows.map((row) => row.id);
      if (screenIds.length === 0) {
        throw Object.assign(new Error('deployment_target_empty'), { statusCode: 409 });
      }
      const offeredCount = strategy === 'canary' ? 1 : Math.min(batchSize, screenIds.length);
      const initialProgress = {
        offered: offeredCount,
        queued: screenIds.length - offeredCount,
      };
      await client.query(
        `INSERT INTO deployments (
           id, release_id, strategy, target_type, target_id, status,
           progress, created_by, started_at
         ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now())`,
        [
          id,
          releaseId,
          strategy,
          targetType,
          targetId,
          JSON.stringify(initialProgress),
          request.roomframeSession.user_id,
        ],
      );
      await client.query(
        `INSERT INTO deployment_targets (
           deployment_id, screen_id, wave_number, status, offered_at
         )
         SELECT $1, candidate.screen_id,
                CASE WHEN candidate.ordinality <= $3 THEN 1 ELSE 2 END,
                CASE WHEN candidate.ordinality <= $3 THEN 'offered' ELSE 'queued' END,
                CASE WHEN candidate.ordinality <= $3 THEN now() ELSE NULL END
         FROM unnest($2::uuid[]) WITH ORDINALITY AS candidate(screen_id, ordinality)`,
        [id, screenIds, offeredCount],
      );
      await writeAudit(client, request, 'deployment.started', 'deployment', id, {
        releaseId,
        strategy,
        targetType,
        targetId,
        offeredCount,
        targetCount: screenIds.length,
      });
      return { offeredCount, targetCount: screenIds.length };
    });
    return reply.code(201).send({
      id,
      status: 'running',
      offeredCount: planned.offeredCount,
      targetCount: planned.targetCount,
      hardwareExecution: 'download-and-verification-active-install-requires-device-owner',
    });
  });

  app.post('/api/v1/deployments/:deploymentId/advance', {
    preHandler: [authenticated, requirePermission('deployments:write'), csrf],
  }, async (request) => {
    const deploymentId = optionalUuid(request.params.deploymentId);
    const batchSize = integerInRange(request.body?.batchSize, 'batch_size', 1, 100, 1);
    return withTransaction(pool, async (client) => {
      const deployment = await client.query(
        "SELECT id, status FROM deployments WHERE id = $1 FOR UPDATE",
        [deploymentId],
      );
      if (!deployment.rows[0]) throw Object.assign(new Error('deployment_not_found'), { statusCode: 404 });
      if (deployment.rows[0].status !== 'running') {
        throw Object.assign(new Error('deployment_not_running'), { statusCode: 409 });
      }
      const blockers = await client.query(
        `SELECT status, count(*)::integer AS count
         FROM deployment_targets
         WHERE deployment_id = $1
           AND status IN ('offered', 'downloading', 'downloaded', 'installing', 'failed')
         GROUP BY status`,
        [deploymentId],
      );
      if (blockers.rows.length > 0) {
        throw Object.assign(new Error('deployment_wave_incomplete'), {
          statusCode: 409,
          states: blockers.rows,
        });
      }
      const next = await client.query(
        `WITH selected AS (
           SELECT screen_id
           FROM deployment_targets
           WHERE deployment_id = $1 AND status = 'queued'
           ORDER BY screen_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ),
         wave AS (
           SELECT COALESCE(max(wave_number), 0) + 1 AS number
           FROM deployment_targets
           WHERE deployment_id = $1
         )
         UPDATE deployment_targets target
         SET status = 'offered', offered_at = now(), updated_at = now(),
             wave_number = wave.number
         FROM selected, wave
         WHERE target.deployment_id = $1
           AND target.screen_id = selected.screen_id
         RETURNING target.screen_id, target.wave_number`,
        [deploymentId, batchSize],
      );
      if (next.rows.length === 0) {
        await client.query(
          `UPDATE deployments
           SET status = 'completed', completed_at = now()
           WHERE id = $1`,
          [deploymentId],
        );
        await writeAudit(client, request, 'deployment.completed', 'deployment', deploymentId);
        return { id: deploymentId, status: 'completed', offeredCount: 0 };
      }
      await writeAudit(client, request, 'deployment.wave.advanced', 'deployment', deploymentId, {
        wave: Number(next.rows[0].wave_number),
        offeredCount: next.rows.length,
      });
      return {
        id: deploymentId,
        status: 'running',
        wave: Number(next.rows[0].wave_number),
        offeredCount: next.rows.length,
      };
    });
  });

  app.post('/api/v1/deployments/:deploymentId/retry', {
    preHandler: [authenticated, requirePermission('deployments:write'), csrf],
  }, async (request) => {
    const deploymentId = optionalUuid(request.params.deploymentId);
    return withTransaction(pool, async (client) => {
      const deployment = await client.query(
        "SELECT id, status FROM deployments WHERE id = $1 FOR UPDATE",
        [deploymentId],
      );
      if (!deployment.rows[0]) {
        throw Object.assign(new Error('deployment_not_found'), { statusCode: 404 });
      }
      if (deployment.rows[0].status !== 'running') {
        throw Object.assign(new Error('deployment_not_running'), { statusCode: 409 });
      }
      const retried = await client.query(
        `UPDATE deployment_targets
         SET status = 'offered', offered_at = now(), error_code = NULL,
             reported_version = NULL, updated_at = now()
         WHERE deployment_id = $1 AND status IN ('failed', 'deferred')
         RETURNING screen_id`,
        [deploymentId],
      );
      if (retried.rowCount === 0) {
        throw Object.assign(new Error('deployment_no_retryable_targets'), { statusCode: 409 });
      }
      const progress = await client.query(
        `SELECT status, count(*)::integer AS count
         FROM deployment_targets
         WHERE deployment_id = $1
         GROUP BY status`,
        [deploymentId],
      );
      const progressDocument = Object.fromEntries(
        progress.rows.map((entry) => [entry.status, Number(entry.count)]),
      );
      await client.query(
        'UPDATE deployments SET progress = $2 WHERE id = $1',
        [deploymentId, JSON.stringify(progressDocument)],
      );
      await writeAudit(client, request, 'deployment.targets.retried', 'deployment', deploymentId, {
        targetCount: retried.rowCount,
      });
      return {
        id: deploymentId,
        status: 'running',
        retriedCount: retried.rowCount,
        progress: progressDocument,
      };
    });
  });

  app.get('/api/v1/tv/update', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request) => {
    const { screen } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'releases:read',
    });
    const target = await pool.query(
      `SELECT target.deployment_id, target.status AS target_status,
              deployment.strategy, release.id AS release_id, release.version,
              release.verification
       FROM deployment_targets target
       JOIN deployments deployment ON deployment.id = target.deployment_id
       JOIN release_history release ON release.id = deployment.release_id
       WHERE target.screen_id = $1
         AND target.status IN ('offered', 'downloading', 'downloaded', 'installing')
         AND deployment.status = 'running'
         AND release.status = 'verified'
       ORDER BY target.offered_at NULLS LAST, deployment.created_at
       LIMIT 1`,
      [screen.id],
    );
    const row = target.rows[0];
    if (!row) return { available: false };
    const artifact = (row.verification?.apkArtifacts ?? []).find(
      (candidate) => candidate.kind === 'home-apk',
    );
    if (!artifact) throw Object.assign(new Error('deployment_apk_unavailable'), { statusCode: 409 });
    return {
      available: true,
      deployment: {
        id: row.deployment_id,
        strategy: row.strategy,
        state: row.target_status,
      },
      release: {
        id: row.release_id,
        version: row.version,
      },
      artifact: {
        packageName: artifact.packageName,
        versionCode: artifact.versionCode,
        sha256: artifact.sha256,
        size: artifact.size,
        signingCertificateSha256: artifact.signingCertificateSha256,
        url: `/api/v1/tv/updates/${row.deployment_id}/apk`,
      },
      installation: {
        packageInstaller: true,
        silentRequiresDeviceOwner: true,
      },
    };
  });

  app.get('/api/v1/tv/updates/:deploymentId/apk', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const deploymentId = optionalUuid(request.params.deploymentId);
    const { screen } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'releases:read',
    });
    const target = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `SELECT target.status, release.verification
         FROM deployment_targets target
         JOIN deployments deployment ON deployment.id = target.deployment_id
         JOIN release_history release ON release.id = deployment.release_id
         WHERE target.deployment_id = $1
           AND target.screen_id = $2
           AND target.status IN ('offered', 'downloading', 'downloaded')
           AND deployment.status = 'running'
           AND release.status = 'verified'
         FOR UPDATE OF target`,
        [deploymentId, screen.id],
      );
      if (!result.rows[0]) {
        throw Object.assign(new Error('update_download_not_authorized'), { statusCode: 403 });
      }
      await client.query(
        `UPDATE deployment_targets
         SET status = CASE WHEN status = 'downloaded' THEN status ELSE 'downloading' END,
             updated_at = now()
         WHERE deployment_id = $1 AND screen_id = $2`,
        [deploymentId, screen.id],
      );
      return result.rows[0];
    });
    const artifact = (target.verification?.apkArtifacts ?? []).find(
      (candidate) => candidate.kind === 'home-apk',
    );
    if (!artifact?.storagePath) {
      throw Object.assign(new Error('deployment_apk_unavailable'), { statusCode: 409 });
    }
    const artifactRoot = path.resolve(config.releasesDir, 'artifacts');
    const file = path.resolve(artifact.storagePath);
    if (!file.startsWith(`${artifactRoot}${path.sep}`)) {
      throw Object.assign(new Error('deployment_apk_storage_invalid'), { statusCode: 500 });
    }
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size) {
      throw Object.assign(new Error('deployment_apk_storage_invalid'), { statusCode: 500 });
    }
    reply.header('content-type', 'application/vnd.android.package-archive');
    reply.header('content-length', String(info.size));
    reply.header('cache-control', 'private, no-store');
    reply.header('etag', `"${artifact.sha256}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });

  app.post('/api/v1/tv/updates/:deploymentId/status', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request) => {
    const deploymentId = optionalUuid(request.params.deploymentId);
    const { screen } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'deployments:write',
    });
    const nextStatus = String(request.body?.status ?? '');
    if (!['downloaded', 'installing', 'installed', 'failed', 'deferred'].includes(nextStatus)) {
      throw Object.assign(new Error('invalid_update_status'), { statusCode: 400 });
    }
    const reportedVersion = request.body?.version
      ? cleanText(request.body.version, 'reported_version', 100)
      : null;
    const errorCode = request.body?.errorCode
      ? cleanText(request.body.errorCode, 'update_error_code', 80)
      : null;
    if (errorCode && !/^[A-Za-z0-9._-]+$/.test(errorCode)) {
      throw Object.assign(new Error('invalid_update_error_code'), { statusCode: 400 });
    }
    return withTransaction(pool, async (client) => {
      const locked = await client.query(
        `SELECT target.status, release.version
         FROM deployment_targets target
         JOIN deployments deployment ON deployment.id = target.deployment_id
         JOIN release_history release ON release.id = deployment.release_id
         WHERE target.deployment_id = $1 AND target.screen_id = $2
         FOR UPDATE OF target`,
        [deploymentId, screen.id],
      );
      const current = locked.rows[0];
      if (!current) throw Object.assign(new Error('deployment_target_not_found'), { statusCode: 404 });
      if (nextStatus === 'installed' && reportedVersion !== current.version) {
        throw Object.assign(new Error('installed_version_mismatch'), { statusCode: 409 });
      }
      if (nextStatus === 'failed' && !errorCode) {
        throw Object.assign(new Error('update_error_code_required'), { statusCode: 400 });
      }
      const transitions = {
        offered: new Set(['downloaded', 'failed', 'deferred']),
        downloading: new Set(['downloaded', 'failed', 'deferred']),
        downloaded: new Set(['installing', 'failed', 'deferred']),
        installing: new Set(['installed', 'failed']),
      };
      if (!transitions[current.status]?.has(nextStatus)) {
        throw Object.assign(new Error('invalid_update_status_transition'), { statusCode: 409 });
      }
      await client.query(
        `UPDATE deployment_targets
         SET status = $3,
             downloaded_at = CASE WHEN $3 = 'downloaded' THEN now() ELSE downloaded_at END,
             installed_at = CASE WHEN $3 = 'installed' THEN now() ELSE installed_at END,
             reported_version = $4,
             error_code = $5,
             updated_at = now()
         WHERE deployment_id = $1 AND screen_id = $2`,
        [deploymentId, screen.id, nextStatus, reportedVersion, errorCode],
      );
      if (nextStatus === 'installed') {
        await client.query(
          `UPDATE screens
           SET home_version = $2, updated_at = now(), last_seen_at = now()
           WHERE id = $1`,
          [screen.id, current.version],
        );
      }
      const progress = await client.query(
        `SELECT status, count(*)::integer AS count
         FROM deployment_targets
         WHERE deployment_id = $1
         GROUP BY status`,
        [deploymentId],
      );
      const progressDocument = Object.fromEntries(
        progress.rows.map((entry) => [entry.status, Number(entry.count)]),
      );
      await client.query(
        'UPDATE deployments SET progress = $2 WHERE id = $1',
        [deploymentId, JSON.stringify(progressDocument)],
      );
      await appendAudit(client, {
        actorType: 'tv',
        action: `tv.update.${nextStatus}`,
        targetType: 'deployment',
        targetId: deploymentId,
        remoteAddress: request.ip,
        details: { screenId: screen.id, reportedVersion, errorCode },
      });
      return { deploymentId, status: nextStatus, progress: progressDocument };
    });
  });

  app.get('/api/v1/default-assets/*', async (request, reply) => {
    const { screen, session } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'studio:read',
    });
    const requested = `assets/${String(request.params['*'] ?? '')}`.replace(/^assets\/assets\//, 'assets/');
    if (!session) {
      const assignedScene = await sceneForScreen(pool, screen);
      if (!referencedDefaultAssets(assignedScene.document).has(requested)) {
        return reply.code(404).send({ error: 'default_asset_not_found' });
      }
    }
    const descriptor = experience.manifest.files.find((entry) => entry.path === requested);
    if (!descriptor || !requested.startsWith('assets/')) {
      return reply.code(404).send({ error: 'default_asset_not_found' });
    }
    const file = path.resolve(config.defaultBundleDir, requested);
    if (!file.startsWith(`${path.resolve(config.defaultBundleDir)}${path.sep}`)) {
      return reply.code(404).send({ error: 'default_asset_not_found' });
    }
    await stat(file);
    reply.header('content-type', defaultAssetMime(file));
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('etag', `"${descriptor.sha256}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(file));
  });

  app.get('/api/v1/tv/sync', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request) => {
    const { screen, session } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'studio:read',
    });
    const syncResult = await pool.query('SELECT revision FROM sync_state WHERE singleton = true');
    const revision = Number(syncResult.rows[0]?.revision ?? 1);
    const current = Number(request.query?.revision ?? 0);
    if (!session) {
      await pool.query(
        'UPDATE screens SET last_seen_at = now(), updated_at = now() WHERE id = $1',
        [screen.id],
      );
    }
    if (current === revision) return { upToDate: true, revision };

    const sceneRecord = await sceneForScreen(pool, screen);
    const [messagesResult, sourcesResult, powerResult, instanceResult] = await Promise.all([
      pool.query(
        `SELECT id, title, body, priority, starts_at, ends_at
         FROM messages
         WHERE active = true
           AND (starts_at IS NULL OR starts_at <= now())
           AND (ends_at IS NULL OR ends_at > now())
           AND (
             (target_type = 'instance' AND target_id IS NULL)
             OR (target_type = 'group' AND target_id = $1)
             OR (target_type = 'tv' AND target_id = $2)
           )
         ORDER BY priority DESC, created_at DESC
         LIMIT 50`,
        [screen.group_id, screen.id],
      ),
      pool.query(
        `SELECT DISTINCT ON (source_kind)
                source_kind, enabled, label, configuration, target_type
         FROM source_settings
         WHERE
           (target_type = 'instance' AND target_id IS NULL)
           OR (target_type = 'group' AND target_id = $1)
           OR (target_type = 'tv' AND target_id = $2)
         ORDER BY source_kind,
           CASE target_type WHEN 'tv' THEN 1 WHEN 'group' THEN 2 ELSE 3 END`,
        [screen.group_id, screen.id],
      ),
      pool.query(
        `SELECT *
         FROM power_schedules
         WHERE
           (target_type = 'instance' AND target_id IS NULL)
           OR (target_type = 'group' AND target_id = $1)
           OR (target_type = 'tv' AND target_id = $2)
         ORDER BY CASE target_type WHEN 'tv' THEN 1 WHEN 'group' THEN 2 ELSE 3 END
         LIMIT 1`,
        [screen.group_id, screen.id],
      ),
      pool.query('SELECT config FROM roomframe_instance WHERE singleton = true'),
    ]);
    const policies = instanceResult.rows[0].config.defaults.policies;
    const power = powerResult.rows[0];
    const schedule = {
      schemaVersion: 2,
      timezone: power?.timezone ?? 'Europe/Paris',
      sourcePolicies: {
        returnHomeWhenInactiveMinutes: policies.returnHomeWhenInactiveMinutes,
        homeSleepMinutes: policies.homeSleepMinutes,
      },
      power: {
        enabled: Boolean(power?.enabled),
        requireCapabilityProbe: true,
        rules: power?.rules ?? [],
      },
    };
    const documents = {
      scene: sceneRecord.document,
      messages: { schemaVersion: 1, items: messagesResult.rows },
      schedule,
      sources: { schemaVersion: 1, items: sourcesResult.rows },
      branding: {
        schemaVersion: 1,
        displayName: instanceResult.rows[0].config.displayName,
        ...instanceResult.rows[0].config.branding,
      },
    };
    const documentEntries = [
      jsonDocument('scene.json', documents.scene),
      jsonDocument('messages.json', documents.messages),
      jsonDocument('schedule.json', documents.schedule),
      jsonDocument('sources.json', documents.sources),
      jsonDocument('branding.json', documents.branding),
    ];

    const brandingLogoId = instanceResult.rows[0].config.branding?.logoAssetId;
    const deliveryScene = brandingLogoId
      ? {
        ...sceneRecord.document,
        nodes: [
          ...(sceneRecord.document.nodes ?? []),
          { kind: 'logo', props: { assetId: brandingLogoId } },
        ],
      }
      : sceneRecord.document;
    const uploadedAssets = await assertSceneAssetsAvailable(
      pool,
      deliveryScene,
      experience,
      'published_scene_assets_unavailable',
    );
    const assetUsages = referencedAssetUsages(deliveryScene);
    const mediaAssets = uploadedAssets.flatMap((asset) => (
      selectMediaDeliveryVariants(asset, assetUsages.get(asset.id))
      .map(([variant, descriptor]) => ({
        id: `${asset.id}:${variant}`,
        assetId: asset.id,
        variant,
        path: `media/${asset.id}/${variant}`,
        url: `/api/v1/media/${asset.id}/${variant}`,
        sha256: descriptor.sha256,
        size: descriptor.size,
        mime: descriptor.mime,
      }))
    ));

    const defaultAssets = [...referencedDefaultAssets(sceneRecord.document)].map((entryPath) => {
      const descriptor = experience.manifest.files.find((entry) => entry.path === entryPath);
      if (!descriptor) throw new Error(`default_asset_missing:${entryPath}`);
      return {
        id: `default:${entryPath}`,
        path: entryPath,
        url: `/api/v1/default-assets/${entryPath.replace(/^assets\//, '')}`,
        sha256: descriptor.sha256,
        size: descriptor.size,
      };
    });

    const manifestBase = {
      formatVersion: 1,
      kind: 'tv-sync',
      revision,
      sceneId: sceneRecord.id,
      sceneRevision: Number(sceneRecord.published_revision),
      generatedAt: new Date().toISOString(),
      documents: documentEntries,
      assets: [...defaultAssets, ...mediaAssets],
    };
    const manifest = {
      ...manifestBase,
      sha256: sha256(canonicalize(manifestBase)),
    };
    validators.assertTvSync(manifest);
    return {
      upToDate: false,
      revision,
      manifest,
      documents,
    };
  });

  app.post('/api/v1/tv/metrics', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { screen } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'fleet:write',
    });
    const body = request.body ?? {};
    const networkState = body.networkState ?? null;
    if (
      networkState !== null
      && !['offline', 'ethernet', 'wifi', 'degraded', 'unknown'].includes(networkState)
    ) {
      throw Object.assign(new Error('invalid_network_state'), { statusCode: 400 });
    }
    const updateState = body.updateState ?? null;
    if (
      updateState !== null
      && !['idle', 'available', 'downloading', 'staged', 'installing', 'ready', 'failed'].includes(updateState)
    ) {
      throw Object.assign(new Error('invalid_update_state'), { statusCode: 400 });
    }
    const metric = {
      startupMs: optionalIntegerInRange(body.startupMs, 'startup_ms', 0, 2_147_483_647),
      resumeMs: optionalIntegerInRange(body.resumeMs, 'resume_ms', 0, 2_147_483_647),
      memoryBytes: optionalIntegerInRange(body.memoryBytes, 'memory_bytes', 0, Number.MAX_SAFE_INTEGER),
      storageFreeBytes: optionalIntegerInRange(
        body.storageFreeBytes,
        'storage_free_bytes',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      networkState,
      syncRevision: optionalIntegerInRange(body.syncRevision, 'sync_revision', 0, Number.MAX_SAFE_INTEGER),
      syncDurationMs: optionalIntegerInRange(
        body.syncDurationMs,
        'sync_duration_ms',
        0,
        2_147_483_647,
      ),
      updateState,
      errorCode: body.errorCode ? cleanText(body.errorCode, 'error_code', 120) : null,
    };
    await pool.query(
      `INSERT INTO device_metrics (
         screen_id, startup_ms, resume_ms, memory_bytes, storage_free_bytes,
         network_state, sync_revision, sync_duration_ms, update_state, error_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        screen.id,
        metric.startupMs,
        metric.resumeMs,
        metric.memoryBytes,
        metric.storageFreeBytes,
        metric.networkState,
        metric.syncRevision,
        metric.syncDurationMs,
        metric.updateState,
        metric.errorCode,
      ],
    );
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/tv/events', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { screen } = await resolveScreen({
      request,
      pool,
      config,
      sessionPermission: 'fleet:write',
    });
    const eventType = cleanText(request.body?.eventType, 'event_type', 100);
    const allowed = new Set([
      'startup', 'resume', 'sync.completed', 'sync.failed', 'source.changed',
      'hdmi.signal', 'update.started', 'update.completed', 'update.failed', 'error',
    ]);
    if (!allowed.has(eventType)) throw Object.assign(new Error('unsupported_event_type'), { statusCode: 400 });
    const severity = request.body?.severity ?? 'info';
    if (!['info', 'warning', 'error'].includes(severity)) {
      throw Object.assign(new Error('invalid_event_severity'), { statusCode: 400 });
    }
    const payload = controlledEventPayload(request.body?.payload ?? {});
    if (Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024) {
      throw Object.assign(new Error('event_payload_too_large'), { statusCode: 413 });
    }
    await pool.query(
      `INSERT INTO device_events (screen_id, event_type, severity, payload)
       VALUES ($1, $2, $3, $4)`,
      [screen.id, eventType, severity, JSON.stringify(payload)],
    );
    return reply.code(202).send({ accepted: true });
  });
};
