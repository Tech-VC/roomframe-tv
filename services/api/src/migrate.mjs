import { loadConfig } from './config.mjs';
import { createPool, runMigrations } from './database.mjs';

const config = await loadConfig({
  applicationName: 'roomframe-migrate',
  requireAuthSecrets: false,
});
const pool = createPool({
  ...config.database,
  application_name: 'roomframe-migrate',
  max: 1,
});

try {
  await runMigrations(pool, config.migrationsDir, {
    migrationRole: config.databaseMigrationRole,
    runtimeRole: config.databaseRuntimeRole,
  });
  console.log('database_migrations_complete');
} finally {
  await pool.end();
}
