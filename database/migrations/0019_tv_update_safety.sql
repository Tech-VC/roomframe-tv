BEGIN;

ALTER TABLE device_metrics
  ADD COLUMN silent_update_capable boolean;

COMMIT;
