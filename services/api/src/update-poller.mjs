import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { createPool } from './database.mjs';
import {
  claimGithubUpdateCheck,
  completeGithubUpdateCheck,
} from './github-update-check.mjs';
import { pollGithubUpdates } from './github-update-poller.mjs';
import { releaseSourceKey } from './update-source.mjs';
import { createValidators } from './validation.mjs';

const config = await loadConfig({
  applicationName: 'roomframe-update-poller',
  requireAuthSecrets: false,
});
const pool = createPool({
  ...config.database,
  application_name: 'roomframe-update-poller',
});
const validators = await createValidators(config.contractsDir);
const lease = await pool.connect();
const acquired = await lease.query(
  "SELECT pg_try_advisory_lock(hashtext('roomframe-github-update-poller')) AS acquired",
);
if (!acquired.rows[0]?.acquired) {
  lease.release();
  await pool.end();
  throw new Error('another_update_poller_is_active');
}

let stopping = false;
let wake = new AbortController();
let wakeSequence = 0;
const stop = () => {
  stopping = true;
  wake.abort();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const sourceKey = releaseSourceKey(
  config.updateGithubRepository,
  config.updateGithubChannel,
);
await lease.query('LISTEN roomframe_github_update_check');
lease.on('notification', (notification) => {
  if (
    notification.channel !== 'roomframe_github_update_check'
    || (notification.payload && notification.payload !== sourceKey)
  ) return;
  wakeSequence += 1;
  wake.abort();
});

const safeErrorCode = (error) => {
  const candidate = String(error?.message ?? 'github_update_poll_failed');
  return /^[a-z0-9][a-z0-9:_-]{0,119}$/.test(candidate)
    ? candidate
    : 'github_update_poll_failed';
};

while (!stopping) {
  const observedWakeSequence = wakeSequence;
  const manualCheck = await claimGithubUpdateCheck(pool, sourceKey);
  try {
    const result = await pollGithubUpdates({ pool, config, validators });
    if (manualCheck) {
      await completeGithubUpdateCheck(pool, sourceKey, manualCheck.id, {
        status: 'completed',
        result: result.status,
      });
    }
    if (result.status !== 'disabled' && result.status !== 'not-modified') {
      console.log(`github_update_poll:${result.status}`);
    }
  } catch (error) {
    const code = safeErrorCode(error);
    if (manualCheck) {
      await completeGithubUpdateCheck(pool, sourceKey, manualCheck.id, {
        status: 'failed',
        result: 'error',
        errorCode: code,
      }).catch(() => {});
    }
    console.error(`github_update_poll:${code}`);
  }
  if (stopping) break;
  if (wakeSequence !== observedWakeSequence) continue;
  wake = new AbortController();
  if (wakeSequence !== observedWakeSequence) continue;
  await delay(
    config.updatePollMinutes * 60 * 1000,
    undefined,
    { signal: wake.signal },
  ).catch((error) => {
    if (error?.name !== 'AbortError') throw error;
  });
}

await lease.query(
  'UNLISTEN roomframe_github_update_check',
).catch(() => {});
await lease.query(
  "SELECT pg_advisory_unlock(hashtext('roomframe-github-update-poller'))",
).catch(() => {});
lease.release();
await pool.end();
