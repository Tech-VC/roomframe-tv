WITH policy AS MATERIALIZED (
  SELECT
    minimum_import_age_minutes,
    window_start,
    window_end,
    timezone,
    (CURRENT_TIMESTAMP AT TIME ZONE timezone)::time AS local_time
  FROM server_update_policy
  WHERE singleton = true
    AND mode = 'automatic'
),
candidate AS MATERIALIZED (
  SELECT
    release.id,
    release.version,
    policy.minimum_import_age_minutes,
    policy.window_start,
    policy.window_end,
    policy.timezone
  FROM release_history AS release
  CROSS JOIN policy
  WHERE release.status = 'verified'
    AND release.deployed_at IS NULL
    AND release.imported_at <= now() - make_interval(mins => policy.minimum_import_age_minutes)
    AND release.verification #>> '{source,provider}' = 'github'
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(release.manifest -> 'artifacts') AS artifact
      WHERE artifact ->> 'kind' = 'server-archive'
    ) = 1
    AND (
      CASE
        WHEN policy.window_start < policy.window_end
          THEN policy.local_time >= policy.window_start
            AND policy.local_time < policy.window_end
        ELSE policy.local_time >= policy.window_start
          OR policy.local_time < policy.window_end
      END
    )
    AND NOT EXISTS (
      SELECT 1
      FROM server_update_requests AS previous
      WHERE previous.release_id = release.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM server_update_requests AS active
      WHERE active.status IN ('pending', 'running')
    )
  ORDER BY release.imported_at DESC, release.id
  LIMIT 1
),
queued AS (
  INSERT INTO server_update_requests (
    id,
    release_id,
    requested_by,
    confirmed_version
  )
  SELECT
    gen_random_uuid(),
    candidate.id,
    NULL,
    candidate.version
  FROM candidate
  ON CONFLICT DO NOTHING
  RETURNING id, release_id, confirmed_version
)
INSERT INTO audit_log (
  actor_type,
  action,
  target_type,
  target_id,
  details
)
SELECT
  'system',
  'release.server_apply_auto_requested',
  'release',
  queued.release_id::text,
  jsonb_build_object(
    'requestId', queued.id,
    'version', queued.confirmed_version,
    'minimumImportAgeMinutes', candidate.minimum_import_age_minutes,
    'windowStart', to_char(candidate.window_start, 'HH24:MI'),
    'windowEnd', to_char(candidate.window_end, 'HH24:MI'),
    'timezone', candidate.timezone
  )
FROM queued
JOIN candidate ON candidate.id = queued.release_id;
