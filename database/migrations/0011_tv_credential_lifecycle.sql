BEGIN;

ALTER TABLE screens
  ADD COLUMN device_key_pending text;

ALTER TABLE screens
  ADD COLUMN device_key_pending_expires_at timestamptz;

ALTER TABLE screens
  ADD COLUMN credential_generation bigint NOT NULL DEFAULT 1;

ALTER TABLE screens
  ADD COLUMN credentials_revoked_at timestamptz;

CREATE UNIQUE INDEX screens_device_key_pending_unique
ON screens (device_key_pending)
WHERE device_key_pending IS NOT NULL;

CREATE INDEX screens_device_key_pending_expiry
ON screens (device_key_pending_expires_at)
WHERE device_key_pending IS NOT NULL;

ALTER TABLE screens
  ADD CONSTRAINT screens_credential_generation_positive
  CHECK (credential_generation >= 1) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_pending_credential_shape
  CHECK (
    (device_key_pending IS NULL AND device_key_pending_expires_at IS NULL)
    OR (
      enrollment_state = 'active'
      AND device_key_pending IS NOT NULL
      AND device_key_pending_expires_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE screens VALIDATE CONSTRAINT screens_credential_generation_positive;
ALTER TABLE screens VALIDATE CONSTRAINT screens_pending_credential_shape;

COMMIT;
