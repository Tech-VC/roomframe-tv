BEGIN;

CREATE TABLE IF NOT EXISTS update_poll_state (
  source_key text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('github')),
  repository text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('stable', 'preview')),
  etag text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_result text NOT NULL DEFAULT 'never' CHECK (
    last_result IN (
      'never',
      'not-modified',
      'no-candidate',
      'already-imported',
      'imported',
      'rejected',
      'error'
    )
  ),
  last_error_code text,
  external_release_id bigint,
  external_asset_id bigint,
  external_asset_updated_at timestamptz,
  imported_release_id uuid REFERENCES release_history(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS update_poll_state_checked_idx
  ON update_poll_state (last_checked_at DESC);

COMMIT;
