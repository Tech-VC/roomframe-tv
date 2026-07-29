BEGIN;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_salt bytea;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_iv bytea;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_ciphertext bytea;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_tag bytea;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_fingerprint_sha256 text;

ALTER TABLE screens
  ADD COLUMN server_ca_bootstrap_created_at timestamptz;

ALTER TABLE screens
  ADD CONSTRAINT screens_server_ca_bootstrap_shape
  CHECK (
    (
      server_ca_bootstrap_salt IS NULL
      AND server_ca_bootstrap_iv IS NULL
      AND server_ca_bootstrap_ciphertext IS NULL
      AND server_ca_bootstrap_tag IS NULL
      AND server_ca_bootstrap_fingerprint_sha256 IS NULL
      AND server_ca_bootstrap_created_at IS NULL
    )
    OR (
      enrollment_state = 'pending'
      AND octet_length(server_ca_bootstrap_salt) = 32
      AND octet_length(server_ca_bootstrap_iv) = 12
      AND octet_length(server_ca_bootstrap_ciphertext) BETWEEN 500 AND 16384
      AND octet_length(server_ca_bootstrap_tag) = 16
      AND server_ca_bootstrap_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
      AND server_ca_bootstrap_created_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE screens
  VALIDATE CONSTRAINT screens_server_ca_bootstrap_shape;

COMMIT;
