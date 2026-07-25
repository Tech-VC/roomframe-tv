import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { createPool, runMigrations } from './database.mjs';
import {
  processOneMediaJob,
  recoverAbandonedMediaJobs,
} from './media-worker.mjs';

const config = await loadConfig({
  applicationName: 'roomframe-worker',
  requireAuthSecrets: false,
});
const pool = createPool({ ...config.database, application_name: 'roomframe-worker' });
await runMigrations(pool, config.migrationsDir);
const workerLease = await pool.connect();
const acquired = await workerLease.query(
  "SELECT pg_try_advisory_lock(hashtext('roomframe-media-worker')) AS acquired",
);
if (!acquired.rows[0]?.acquired) {
  workerLease.release();
  await pool.end();
  throw new Error('another_media_worker_is_active');
}
await recoverAbandonedMediaJobs(pool);

const runMaintenance = async () => {
  await Promise.all([
    pool.query(
      `DELETE FROM device_metrics
       WHERE recorded_at < now() - make_interval(days => $1)`,
      [config.telemetryRetentionDays],
    ),
    pool.query(
      `DELETE FROM device_events
       WHERE created_at < now() - make_interval(days => $1)`,
      [config.telemetryRetentionDays],
    ),
    pool.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'"),
    pool.query("DELETE FROM bootstrap_challenges WHERE expires_at < now() - interval '7 days'"),
    pool.query("DELETE FROM recovery_authorities WHERE expires_at < now() - interval '7 days'"),
  ]);
};
await runMaintenance();

let stopping = false;
let nextMaintenance = Date.now() + 60 * 60 * 1000;
const stop = () => { stopping = true; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

while (!stopping) {
  const processed = await processOneMediaJob(pool, config);
  if (Date.now() >= nextMaintenance) {
    await runMaintenance();
    nextMaintenance = Date.now() + 60 * 60 * 1000;
  }
  if (!processed) await delay(1500);
}

await workerLease.query(
  "SELECT pg_advisory_unlock(hashtext('roomframe-media-worker'))",
).catch(() => {});
workerLease.release();
await pool.end();
