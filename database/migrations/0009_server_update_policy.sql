BEGIN;

CREATE TABLE IF NOT EXISTS server_update_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'manual'
    CHECK (mode IN ('manual', 'automatic')),
  minimum_import_age_minutes integer NOT NULL DEFAULT 60
    CHECK (minimum_import_age_minutes BETWEEN 15 AND 10080),
  window_start time without time zone NOT NULL DEFAULT '02:00',
  window_end time without time zone NOT NULL DEFAULT '05:00',
  timezone text NOT NULL DEFAULT 'UTC'
    CHECK (char_length(timezone) BETWEEN 1 AND 100),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start <> window_end)
);

INSERT INTO server_update_policy (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

COMMIT;
