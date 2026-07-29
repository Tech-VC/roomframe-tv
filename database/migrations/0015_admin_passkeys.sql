BEGIN;

ALTER TABLE users
  ADD COLUMN webauthn_user_id bytea;

UPDATE users
SET webauthn_user_id = decode(replace(id::text, '-', ''), 'hex')
WHERE webauthn_user_id IS NULL;

ALTER TABLE users
  ALTER COLUMN webauthn_user_id SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_webauthn_user_id_length
  CHECK (octet_length(webauthn_user_id) BETWEEN 16 AND 64);

CREATE UNIQUE INDEX users_webauthn_user_id_unique
  ON users (webauthn_user_id);

ALTER TABLE user_webauthn_credentials
  ADD COLUMN device_type text NOT NULL DEFAULT 'singleDevice';

ALTER TABLE user_webauthn_credentials
  ADD COLUMN backed_up boolean NOT NULL DEFAULT false;

ALTER TABLE user_webauthn_credentials
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE user_webauthn_credentials
  ADD CONSTRAINT user_webauthn_credentials_device_type
  CHECK (device_type IN ('singleDevice', 'multiDevice'));

ALTER TABLE user_webauthn_credentials
  ADD CONSTRAINT user_webauthn_credentials_label_length
  CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80);

ALTER TABLE user_webauthn_credentials
  ADD CONSTRAINT user_webauthn_credentials_material_size
  CHECK (
    octet_length(credential_id) BETWEEN 16 AND 4096
    AND octet_length(public_key) BETWEEN 16 AND 4096
  );

ALTER TABLE user_webauthn_credentials
  ADD CONSTRAINT user_webauthn_credentials_transports
  CHECK (
    transports <@ ARRAY[
      'ble',
      'cable',
      'hybrid',
      'internal',
      'nfc',
      'smart-card',
      'usb'
    ]::text[]
  );

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge text NOT NULL CHECK (
    char_length(challenge) BETWEEN 32 AND 256
    AND challenge ~ '^[A-Za-z0-9_-]+$'
  ),
  expected_origin text NOT NULL,
  rp_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (purpose = 'registration' AND session_id IS NOT NULL)
    OR (purpose = 'authentication' AND session_id IS NULL)
  )
);

CREATE INDEX webauthn_challenges_active_idx
  ON webauthn_challenges (user_id, purpose, expires_at)
  WHERE used_at IS NULL;

COMMIT;
