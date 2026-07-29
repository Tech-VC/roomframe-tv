BEGIN;

CREATE POLICY deployment_targets_runtime_access
  ON deployment_targets
  FOR ALL
  TO roomframe_runtime
  USING (true)
  WITH CHECK (true);

COMMIT;
