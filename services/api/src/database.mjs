import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export const createPool = (database) => new Pool({
  ...database,
  ssl: false,
  allowExitOnIdle: false,
});

const migrationBody = (sql) => sql
  .replace(/^\s*BEGIN\s*;\s*/i, '')
  .replace(/\s*COMMIT\s*;\s*$/i, '');

const safeRole = (role, label) => {
  if (role === null || role === undefined || role === '') return null;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`${label}_invalid`);
  }
  return `"${role}"`;
};

export const runMigrations = async (
  pool,
  migrationsDir,
  { migrationRole = null, runtimeRole = null } = {},
) => {
  const quotedMigrationRole = safeRole(migrationRole, 'migration_role');
  const quotedRuntimeRole = safeRole(runtimeRole, 'runtime_role');
  const client = await pool.connect();
  try {
    if (quotedMigrationRole) {
      await client.query(`SET ROLE ${quotedMigrationRole}`);
    }
    await client.query("SELECT pg_advisory_lock(hashtext('roomframe-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum_sha256 text NOT NULL
      )
    `);
    const entries = (await readdir(migrationsDir))
      .filter((name) => /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const filename of entries) {
      const version = path.basename(filename, '.sql');
      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      await client.query('BEGIN');
      try {
        const existing = await client.query(
          'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1 FOR UPDATE',
          [version],
        );
        if (existing.rowCount > 0) {
          if (existing.rows[0].checksum_sha256 !== checksum) {
            throw new Error(`migration_checksum_mismatch:${version}`);
          }
          await client.query('COMMIT');
          continue;
        }
        await client.query(migrationBody(sql));
        await client.query(
          'INSERT INTO schema_migrations(version, checksum_sha256) VALUES ($1, $2)',
          [version, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (quotedRuntimeRole) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM ${quotedRuntimeRole}`,
      );
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('roomframe-schema-migrations'))").catch(() => {});
    if (quotedMigrationRole) {
      await client.query('RESET ROLE').catch(() => {});
    }
    client.release();
  }
};

export const withTransaction = async (pool, callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const oneOrNull = (result) => result.rows[0] ?? null;
