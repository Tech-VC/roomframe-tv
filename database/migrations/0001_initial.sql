BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum_sha256 text NOT NULL
);

CREATE TABLE IF NOT EXISTS roomframe_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL,
  display_name text NOT NULL,
  configured_at timestamptz NOT NULL,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL UNIQUE,
  media_type text NOT NULL,
  storage_path text NOT NULL,
  width integer,
  height integer,
  duration_ms bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS layouts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  scene jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screens (
  id uuid PRIMARY KEY,
  device_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  room_name text NOT NULL,
  layout_id uuid REFERENCES layouts(id),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_items (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  asset_id uuid REFERENCES assets(id),
  starts_at timestamptz,
  ends_at timestamptz,
  targeting jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release_history (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz
);

COMMIT;
