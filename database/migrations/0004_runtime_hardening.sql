BEGIN;

ALTER TABLE bootstrap_challenges
  ADD COLUMN subject text;

ALTER TABLE screens
  ADD COLUMN enrollment_expires_at timestamptz;

ALTER TABLE screens
  ADD COLUMN device_key_rotated_at timestamptz;

CREATE TABLE recovery_authorities (
  token_hash char(64) PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recovery_authorities_expiry_idx
  ON recovery_authorities (expires_at)
  WHERE consumed_at IS NULL;

CREATE UNIQUE INDEX media_jobs_one_active_per_asset
  ON media_jobs (asset_id)
  WHERE status IN ('queued', 'processing');

CREATE INDEX device_metrics_retention_idx
  ON device_metrics (recorded_at);

CREATE INDEX device_events_retention_idx
  ON device_events (created_at);

CREATE UNIQUE INDEX scene_assignments_target_unique_v2
  ON scene_assignments (
    target_type,
    COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE UNIQUE INDEX source_settings_target_unique_v2
  ON source_settings (
    target_type,
    COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_kind
  );

CREATE UNIQUE INDEX power_schedules_target_unique_v2
  ON power_schedules (
    target_type,
    COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE scene_assignments
  ADD CONSTRAINT scene_assignments_target_shape
  CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE messages
  ADD CONSTRAINT messages_target_shape
  CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE messages
  ADD CONSTRAINT messages_priority_range
  CHECK (priority BETWEEN -100 AND 100) NOT VALID;

ALTER TABLE source_settings
  ADD CONSTRAINT source_settings_target_shape
  CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE power_schedules
  ADD CONSTRAINT power_schedules_target_shape
  CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE assets
  ADD CONSTRAINT assets_focal_x_range
  CHECK (focal_x BETWEEN 0 AND 1) NOT VALID;

ALTER TABLE assets
  ADD CONSTRAINT assets_focal_y_range
  CHECK (focal_y BETWEEN 0 AND 1) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_enrollment_state_known
  CHECK (enrollment_state IN ('pending', 'active', 'simulated', 'revoked')) NOT VALID;

ALTER TABLE scene_assignments VALIDATE CONSTRAINT scene_assignments_target_shape;
ALTER TABLE messages VALIDATE CONSTRAINT messages_target_shape;
ALTER TABLE messages VALIDATE CONSTRAINT messages_priority_range;
ALTER TABLE source_settings VALIDATE CONSTRAINT source_settings_target_shape;
ALTER TABLE power_schedules VALIDATE CONSTRAINT power_schedules_target_shape;
ALTER TABLE assets VALIDATE CONSTRAINT assets_focal_x_range;
ALTER TABLE assets VALIDATE CONSTRAINT assets_focal_y_range;
ALTER TABLE screens VALIDATE CONSTRAINT screens_enrollment_state_known;

COMMIT;
