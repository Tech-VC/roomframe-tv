BEGIN;

CREATE TABLE IF NOT EXISTS scene_schedules (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES scenes(id),
  target_type text NOT NULL
    CHECK (target_type IN ('instance', 'group', 'tv')),
  target_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (
    (target_type = 'instance' AND target_id IS NULL)
    OR (target_type IN ('group', 'tv') AND target_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS scene_schedules_due
ON scene_schedules (status, starts_at, ends_at)
WHERE status IN ('scheduled', 'active');

CREATE INDEX IF NOT EXISTS scene_schedules_target
ON scene_schedules (target_type, target_id, starts_at DESC);

COMMIT;
