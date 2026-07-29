import { appendAudit } from './auth.mjs';
import { withTransaction } from './database.mjs';

export const processSceneScheduleTransitions = async (
  pool,
  now = new Date(),
) => withTransaction(pool, async (client) => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('roomframe-scene-schedule-transitions'))",
  );
  const transitioned = await client.query(
    `WITH due AS (
       SELECT
         id,
         status AS previous_status,
         CASE
           WHEN ends_at IS NOT NULL AND ends_at <= $1 THEN 'completed'
           ELSE 'active'
         END AS next_status
       FROM scene_schedules
       WHERE status IN ('scheduled', 'active')
         AND (
           (status = 'scheduled' AND starts_at <= $1)
           OR (ends_at IS NOT NULL AND ends_at <= $1)
         )
       ORDER BY COALESCE(ends_at, starts_at), starts_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 200
     ),
     changed AS (
       UPDATE scene_schedules AS schedule
       SET status = due.next_status,
           activated_at = CASE
             WHEN due.next_status = 'active'
               THEN COALESCE(schedule.activated_at, $1)
             ELSE schedule.activated_at
           END,
           completed_at = CASE
             WHEN due.next_status = 'completed' THEN $1
             ELSE schedule.completed_at
           END,
           updated_at = $1
       FROM due
       WHERE schedule.id = due.id
         AND schedule.status <> due.next_status
       RETURNING
         schedule.id,
         schedule.scene_id,
         schedule.target_type,
         schedule.target_id,
         due.previous_status,
         schedule.status
     )
     SELECT * FROM changed`,
    [now],
  );
  const effectiveChanges = transitioned.rows.filter((row) => (
    row.status === 'active' || row.previous_status === 'active'
  ));
  const sync = effectiveChanges.length > 0
    ? await client.query(
      `UPDATE sync_state
       SET revision = revision + 1, updated_at = now()
       WHERE singleton = true
       RETURNING revision`,
    )
    : null;
  const syncRevision = sync ? Number(sync.rows[0].revision) : null;
  for (const row of transitioned.rows) {
    await appendAudit(client, {
      actorType: 'system',
      action: row.status === 'active'
        ? 'scene.schedule.activated'
        : 'scene.schedule.completed',
      targetType: 'scene-schedule',
      targetId: row.id,
      details: {
        sceneId: row.scene_id,
        targetType: row.target_type,
        targetId: row.target_id,
        previousStatus: row.previous_status,
        syncRevision,
      },
    });
  }
  return {
    transitioned: transitioned.rowCount,
    effectiveChanges: effectiveChanges.length,
    syncRevision,
  };
});
