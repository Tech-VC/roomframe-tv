BEGIN;

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_type_check
  CHECK (
    actor_type IN (
      'user',
      'tv',
      'system',
      'local-recovery',
      'invitation'
    )
  );

CREATE TABLE user_invitations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  challenge_id uuid,
  totp_secret_encrypted jsonb,
  challenge_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      challenge_id IS NULL
      AND totp_secret_encrypted IS NULL
      AND challenge_expires_at IS NULL
    )
    OR (
      challenge_id IS NOT NULL
      AND totp_secret_encrypted IS NOT NULL
      AND challenge_expires_at IS NOT NULL
    )
  ),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX user_invitations_one_active_per_user
  ON user_invitations (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX user_invitations_expiry_idx
  ON user_invitations (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

COMMIT;
