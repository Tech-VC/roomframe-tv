BEGIN;

ALTER TABLE screens
  ADD COLUMN client_certificate_fingerprint text;

ALTER TABLE screens
  ADD COLUMN client_certificate_serial text;

ALTER TABLE screens
  ADD COLUMN client_certificate_issued_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_expires_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_required_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_activated_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_revoked_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_pending_fingerprint text;

ALTER TABLE screens
  ADD COLUMN client_certificate_pending_serial text;

ALTER TABLE screens
  ADD COLUMN client_certificate_pending_issued_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_pending_expires_at timestamptz;

ALTER TABLE screens
  ADD COLUMN client_certificate_pending_required_at timestamptz;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_fingerprint_shape
  CHECK (
    client_certificate_fingerprint IS NULL
    OR client_certificate_fingerprint ~ '^[a-f0-9]{64}$'
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_serial_shape
  CHECK (
    client_certificate_serial IS NULL
    OR client_certificate_serial ~ '^[A-F0-9]{2,40}$'
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_pending_fingerprint_shape
  CHECK (
    client_certificate_pending_fingerprint IS NULL
    OR client_certificate_pending_fingerprint ~ '^[a-f0-9]{64}$'
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_pending_serial_shape
  CHECK (
    client_certificate_pending_serial IS NULL
    OR client_certificate_pending_serial ~ '^[A-F0-9]{2,40}$'
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_dates_ordered
  CHECK (
    client_certificate_issued_at IS NULL
    OR (
      client_certificate_expires_at > client_certificate_issued_at
      AND client_certificate_required_at >= client_certificate_issued_at
      AND client_certificate_required_at < client_certificate_expires_at
    )
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_shape
  CHECK (
    (
      client_certificate_fingerprint IS NULL
      AND client_certificate_serial IS NULL
      AND client_certificate_issued_at IS NULL
      AND client_certificate_expires_at IS NULL
      AND client_certificate_required_at IS NULL
      AND client_certificate_activated_at IS NULL
    )
    OR (
      client_certificate_fingerprint IS NOT NULL
      AND client_certificate_serial IS NOT NULL
      AND client_certificate_issued_at IS NOT NULL
      AND client_certificate_expires_at IS NOT NULL
      AND client_certificate_required_at IS NOT NULL
      AND client_certificate_activated_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE screens
  ADD CONSTRAINT screens_client_certificate_pending_shape
  CHECK (
    (
      client_certificate_pending_fingerprint IS NULL
      AND client_certificate_pending_serial IS NULL
      AND client_certificate_pending_issued_at IS NULL
      AND client_certificate_pending_expires_at IS NULL
      AND client_certificate_pending_required_at IS NULL
    )
    OR (
      client_certificate_pending_fingerprint IS NOT NULL
      AND client_certificate_pending_serial IS NOT NULL
      AND client_certificate_pending_issued_at IS NOT NULL
      AND client_certificate_pending_expires_at
        > client_certificate_pending_issued_at
      AND client_certificate_pending_required_at
        >= client_certificate_pending_issued_at
      AND client_certificate_pending_required_at
        < client_certificate_pending_expires_at
    )
  ) NOT VALID;

CREATE UNIQUE INDEX screens_client_certificate_fingerprint_unique
ON screens (client_certificate_fingerprint)
WHERE client_certificate_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX screens_client_certificate_serial_unique
ON screens (client_certificate_serial)
WHERE client_certificate_serial IS NOT NULL;

CREATE UNIQUE INDEX screens_client_certificate_pending_fingerprint_unique
ON screens (client_certificate_pending_fingerprint)
WHERE client_certificate_pending_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX screens_client_certificate_pending_serial_unique
ON screens (client_certificate_pending_serial)
WHERE client_certificate_pending_serial IS NOT NULL;

CREATE TABLE tv_certificate_requests (
  id uuid PRIMARY KEY,
  screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  public_key_spki bytea NOT NULL,
  public_key_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  certificate_pem text,
  certificate_fingerprint_sha256 text,
  certificate_serial text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  issued_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tv_certificate_request_public_key_size
    CHECK (octet_length(public_key_spki) BETWEEN 256 AND 1024),
  CONSTRAINT tv_certificate_request_public_key_hash
    CHECK (public_key_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tv_certificate_request_status
    CHECK (status IN ('pending', 'issuing', 'issued', 'failed', 'revoked')),
  CONSTRAINT tv_certificate_request_attempts
    CHECK (attempt_count BETWEEN 0 AND 10),
  CONSTRAINT tv_certificate_request_certificate_shape
    CHECK (
      (
        status <> 'issued'
        AND certificate_pem IS NULL
        AND certificate_fingerprint_sha256 IS NULL
        AND certificate_serial IS NULL
        AND issued_at IS NULL
        AND expires_at IS NULL
      )
      OR (
        status = 'issued'
        AND certificate_pem LIKE '-----BEGIN CERTIFICATE-----%'
        AND octet_length(certificate_pem) BETWEEN 500 AND 16384
        AND certificate_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
        AND certificate_serial ~ '^[A-F0-9]{2,40}$'
        AND issued_at IS NOT NULL
        AND expires_at > issued_at
      )
    )
);

CREATE UNIQUE INDEX tv_certificate_requests_active_screen
ON tv_certificate_requests (screen_id)
WHERE status IN ('pending', 'issuing');

CREATE INDEX tv_certificate_requests_pending
ON tv_certificate_requests (requested_at, id)
WHERE status = 'pending';

ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_fingerprint_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_serial_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_dates_ordered;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_pending_fingerprint_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_pending_serial_shape;
ALTER TABLE screens VALIDATE CONSTRAINT screens_client_certificate_pending_shape;

COMMIT;
