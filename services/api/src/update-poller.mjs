import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { createPool } from './database.mjs';
import { pollGithubUpdates } from './github-update-poller.mjs';
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
const stop = () => {
  stopping = true;
  wake.abort();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

while (!stopping) {
  try {
    const result = await pollGithubUpdates({ pool, config, validators });
    if (result.status !== 'disabled' && result.status !== 'not-modified') {
      console.log(`github_update_poll:${result.status}`);
    }
  } catch (error) {
    const code = /^[a-z0-9][a-z0-9:_-]{0,119}$/.test(String(error?.message))
      ? error.message
      : 'github_update_poll_failed';
    console.error(`github_update_poll:${code}`);
  }
  if (stopping) break;
  wake = new AbortController();
  await delay(
    config.updatePollMinutes * 60 * 1000,
    undefined,
    { signal: wake.signal },
  ).catch((error) => {
    if (error?.name !== 'AbortError') throw error;
  });
}

await lease.query(
  "SELECT pg_advisory_unlock(hashtext('roomframe-github-update-poller'))",
).catch(() => {});
lease.release();
await pool.end();
