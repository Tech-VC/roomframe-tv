BEGIN;

ALTER TABLE screens
  ADD COLUMN enrollment_code_hash char(64),
  ADD COLUMN enrollment_code_bootstrap_salt bytea,
  ADD COLUMN enrollment_code_bootstrap_iv bytea,
  ADD COLUMN enrollment_code_bootstrap_ciphertext bytea,
  ADD COLUMN enrollment_code_bootstrap_tag bytea,
  ADD COLUMN enrollment_code_bootstrap_created_at timestamptz;

CREATE UNIQUE INDEX screens_pending_enrollment_code_idx
  ON screens (enrollment_code_hash)
  WHERE enrollment_state = 'pending' AND enrollment_code_hash IS NOT NULL;

ALTER TABLE screens
  ADD CONSTRAINT screens_enrollment_code_hash_shape
  CHECK (
    enrollment_code_hash IS NULL
    OR enrollment_code_hash ~ '^[a-f0-9]{64}$'
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_enrollment_code_bootstrap_complete
  CHECK (
    (
      enrollment_code_hash IS NULL
      AND enrollment_code_bootstrap_salt IS NULL
      AND enrollment_code_bootstrap_iv IS NULL
      AND enrollment_code_bootstrap_ciphertext IS NULL
      AND enrollment_code_bootstrap_tag IS NULL
      AND enrollment_code_bootstrap_created_at IS NULL
    )
    OR
    (
      enrollment_code_hash IS NOT NULL
      AND enrollment_code_bootstrap_salt IS NOT NULL
      AND octet_length(enrollment_code_bootstrap_salt) = 32
      AND enrollment_code_bootstrap_iv IS NOT NULL
      AND octet_length(enrollment_code_bootstrap_iv) = 12
      AND enrollment_code_bootstrap_ciphertext IS NOT NULL
      AND octet_length(enrollment_code_bootstrap_ciphertext) BETWEEN 500 AND 32768
      AND enrollment_code_bootstrap_tag IS NOT NULL
      AND octet_length(enrollment_code_bootstrap_tag) = 16
      AND enrollment_code_bootstrap_created_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE screens VALIDATE CONSTRAINT screens_enrollment_code_hash_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_enrollment_code_bootstrap_complete;

COMMIT;
