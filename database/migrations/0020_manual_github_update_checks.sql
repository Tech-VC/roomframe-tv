BEGIN;

ALTER TABLE update_poll_state
  ADD COLUMN manual_request_id uuid,
  ADD COLUMN manual_status text CHECK (
    manual_status IS NULL
    OR manual_status IN ('pending', 'running', 'completed', 'failed')
  ),
  ADD COLUMN manual_requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN manual_requested_at timestamptz,
  ADD COLUMN manual_started_at timestamptz,
  ADD COLUMN manual_completed_at timestamptz,
  ADD COLUMN manual_result text CHECK (
    manual_result IS NULL
    OR manual_result IN (
      'disabled',
      'not-modified',
      'no-candidate',
      'already-imported',
      'imported',
      'rejected',
      'error'
    )
  ),
  ADD COLUMN manual_error_code text CHECK (
    manual_error_code IS NULL
    OR manual_error_code ~ '^[a-z0-9][a-z0-9:_-]{0,119}$'
  ),
  ADD CONSTRAINT update_poll_manual_request_consistent CHECK (
    (manual_request_id IS NULL
      AND manual_status IS NULL
      AND manual_requested_at IS NULL
      AND manual_started_at IS NULL
      AND manual_completed_at IS NULL
      AND manual_result IS NULL
      AND manual_error_code IS NULL)
    OR
    (manual_request_id IS NOT NULL
      AND manual_status IS NOT NULL
      AND manual_requested_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS update_poll_state_manual_request_idx
  ON update_poll_state (manual_requested_at DESC)
  WHERE manual_request_id IS NOT NULL;

COMMIT;
