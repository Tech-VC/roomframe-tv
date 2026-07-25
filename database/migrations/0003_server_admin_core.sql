BEGIN;

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permissions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (id, slug, display_name, permissions) VALUES
  ('00000000-0000-4000-8000-000000000010', 'owner', 'Propriétaire', '["*"]'::jsonb),
  ('00000000-0000-4000-8000-000000000011', 'content', 'Contenus', '["instance:read","studio:read","studio:write","media:read","media:write","messages:read","messages:write"]'::jsonb),
  ('00000000-0000-4000-8000-000000000012', 'fleet', 'Parc', '["instance:read","studio:read","fleet:read","fleet:write","metrics:read"]'::jsonb),
  ('00000000-0000-4000-8000-000000000013', 'security', 'Sécurité', '["instance:read","users:read","users:write","audit:read","fleet:read"]'::jsonb),
  ('00000000-0000-4000-8000-000000000014', 'release', 'Versions', '["instance:read","releases:read","releases:write","deployments:write","fleet:read"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  email text,
  password_hash text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  totp_secret_encrypted jsonb NOT NULL,
  last_totp_counter bigint,
  active boolean NOT NULL DEFAULT true,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (username = lower(username)),
  CHECK (char_length(username) BETWEEN 3 AND 80)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_webauthn_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  remote_address text,
  user_agent text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS bootstrap_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('bootstrap', 'recovery')),
  authority_token_hash char(64) NOT NULL,
  totp_secret_encrypted jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bootstrap_challenges_expiry_idx ON bootstrap_challenges (expires_at);

CREATE TABLE IF NOT EXISTS tv_groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE screens ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES tv_groups(id);
ALTER TABLE screens ADD COLUMN IF NOT EXISTS enrollment_state text NOT NULL DEFAULT 'pending';
ALTER TABLE screens ADD COLUMN IF NOT EXISTS agent_version text;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS home_version text;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS active_revision bigint;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS source_state jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS scenes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  current_revision bigint NOT NULL DEFAULT 0,
  published_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scene_revisions (
  scene_id uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  sha256 char(64) NOT NULL,
  change_summary text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (scene_id, revision)
);

CREATE TABLE IF NOT EXISTS scene_assignments (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sync_state (singleton, revision) VALUES (true, 1)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS original_filename text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS original_media_type text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS byte_size bigint;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'ready';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS focal_x numeric(5,4) NOT NULL DEFAULT 0.5;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS focal_y numeric(5,4) NOT NULL DEFAULT 0.5;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

CREATE TABLE IF NOT EXISTS media_jobs (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  input_path text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_jobs_queue_idx ON media_jobs (status, available_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  starts_at timestamptz,
  ends_at timestamptz,
  target_type text NOT NULL DEFAULT 'instance' CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS messages_schedule_idx ON messages (active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS source_settings (
  id uuid PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('airplay', 'cast', 'hdmi', 'private-app')),
  enabled boolean NOT NULL DEFAULT true,
  label text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, source_kind)
);

CREATE TABLE IF NOT EXISTS power_schedules (
  id uuid PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  require_capability_probe boolean NOT NULL DEFAULT true,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS device_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  startup_ms integer,
  resume_ms integer,
  memory_bytes bigint,
  storage_free_bytes bigint,
  network_state text,
  sync_revision bigint,
  sync_duration_ms integer,
  update_state text,
  error_code text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS device_metrics_screen_time_idx ON device_metrics (screen_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS device_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  screen_id uuid REFERENCES screens(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE release_history ADD COLUMN IF NOT EXISTS sha256 char(64);
ALTER TABLE release_history ADD COLUMN IF NOT EXISTS signature_key_id text;
ALTER TABLE release_history ADD COLUMN IF NOT EXISTS verification jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE release_history ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE release_history ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

CREATE UNIQUE INDEX IF NOT EXISTS release_history_version_unique ON release_history (version);
CREATE UNIQUE INDEX IF NOT EXISTS release_history_sha_unique ON release_history (sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES release_history(id),
  strategy text NOT NULL CHECK (strategy IN ('canary', 'progressive', 'all-at-once')),
  target_type text NOT NULL CHECK (target_type IN ('tv', 'group', 'fleet')),
  target_id uuid,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'paused', 'completed', 'failed', 'rolled-back')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'tv', 'system', 'local-recovery')),
  action text NOT NULL,
  target_type text,
  target_id text,
  remote_address text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_time_idx ON audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION roomframe_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION roomframe_reject_audit_mutation();

COMMIT;
