BEGIN;

CREATE TABLE private_access_policies (
  id uuid PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  pin_scrypt_salt text,
  pin_scrypt_hash text,
  pin_generation bigint NOT NULL DEFAULT 0 CHECK (pin_generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT private_access_policies_target_shape CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  ),
  CONSTRAINT private_access_policies_pin_shape CHECK (
    (pin_scrypt_salt IS NULL AND pin_scrypt_hash IS NULL AND pin_generation = 0)
    OR (
      pin_scrypt_salt ~ '^[A-Za-z0-9_-]{22}$'
      AND pin_scrypt_hash ~ '^[A-Za-z0-9_-]{43}$'
      AND pin_generation > 0
    )
  )
);

CREATE UNIQUE INDEX private_access_policies_target_unique
  ON private_access_policies (
    target_type,
    COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE private_access_attempts (
  screen_id uuid PRIMARY KEY REFERENCES screens(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES private_access_policies(id) ON DELETE CASCADE,
  pin_generation bigint NOT NULL CHECK (pin_generation > 0),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX private_access_attempts_locked_idx
  ON private_access_attempts (locked_until)
  WHERE locked_until IS NOT NULL;

CREATE TABLE tv_application_status (
  screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  installed boolean NOT NULL,
  version_name text,
  version_code bigint,
  access_enforced boolean NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, application_id),
  CONSTRAINT tv_application_status_application_id_shape CHECK (
    application_id ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
  ),
  CONSTRAINT tv_application_status_version_name_shape CHECK (
    version_name IS NULL
    OR (
      char_length(version_name) BETWEEN 1 AND 100
      AND version_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT tv_application_status_version_code_range CHECK (
    version_code IS NULL OR version_code >= 0
  )
);

CREATE INDEX tv_application_status_reported_idx
  ON tv_application_status (screen_id, reported_at DESC);

UPDATE sync_state
SET revision = revision + 1,
    updated_at = now()
WHERE singleton = true;

COMMIT;
