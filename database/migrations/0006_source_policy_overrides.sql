BEGIN;

ALTER TABLE power_schedules
  ADD COLUMN IF NOT EXISTS return_home_when_inactive_minutes integer,
  ADD COLUMN IF NOT EXISTS home_sleep_minutes integer;

ALTER TABLE power_schedules
  ADD CONSTRAINT power_schedules_return_home_minutes_range
  CHECK (
    return_home_when_inactive_minutes IS NULL
    OR return_home_when_inactive_minutes BETWEEN 1 AND 1440
  ) NOT VALID;

ALTER TABLE power_schedules
  ADD CONSTRAINT power_schedules_home_sleep_minutes_range
  CHECK (
    home_sleep_minutes IS NULL
    OR home_sleep_minutes BETWEEN 1 AND 1440
  ) NOT VALID;

ALTER TABLE power_schedules
  VALIDATE CONSTRAINT power_schedules_return_home_minutes_range;

ALTER TABLE power_schedules
  VALIDATE CONSTRAINT power_schedules_home_sleep_minutes_range;

COMMIT;
