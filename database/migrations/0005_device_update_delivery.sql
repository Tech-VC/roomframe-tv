CREATE TABLE IF NOT EXISTS deployment_targets (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  wave_number integer NOT NULL DEFAULT 1 CHECK (wave_number >= 1),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'offered',
      'downloading',
      'downloaded',
      'installing',
      'installed',
      'failed',
      'deferred'
    )),
  offered_at timestamptz,
  downloaded_at timestamptz,
  installed_at timestamptz,
  reported_version text,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, screen_id)
);

CREATE INDEX IF NOT EXISTS deployment_targets_screen_status_idx
  ON deployment_targets (screen_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS deployment_targets_deployment_status_idx
  ON deployment_targets (deployment_id, status, wave_number);

ALTER TABLE deployment_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON deployment_targets FROM PUBLIC;
