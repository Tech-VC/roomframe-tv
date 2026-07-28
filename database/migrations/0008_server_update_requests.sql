BEGIN;

CREATE TABLE IF NOT EXISTS server_update_requests (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES release_history(id),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rolled-back')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confirmed_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,80}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS server_update_one_active
ON server_update_requests ((true))
WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS server_update_requests_time
ON server_update_requests (requested_at DESC);

COMMIT;
