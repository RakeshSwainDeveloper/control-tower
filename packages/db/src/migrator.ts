import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export interface MigratorOptions {
  /** Connection string. Must be the MIGRATOR role, not the app role:
   *  the app role must never own tables, or it would bypass RLS. */
  connectionString: string;
  migrationsDir: string;
  /** Role that receives table grants. Passed to migrations as ct.app_role. */
  appRole: string;
  logger?: (msg: string) => void;
}

export interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const filename of files) {
    const sql = await readFile(join(dir, filename), 'utf8');
    const version = filename.replace(/\.sql$/, '');
    out.push({
      version,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 32),
    });
  }
  return out;
}

/**
 * Applies pending migrations, each inside its own transaction.
 *
 * Two guarantees that matter:
 *  - a migration that fails leaves NO partial schema (single transaction);
 *  - an already-applied migration whose file has since changed is a hard
 *    error, not a silent skip. Editing an applied migration is how staging
 *    and production drift apart without anyone noticing.
 */
export async function migrateUp(opts: MigratorOptions): Promise<string[]> {
  const log = opts.logger ?? ((m) => console.log(m));
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS app`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER NOT NULL
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM app.schema_migrations`,
    );
    const seen = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of await loadMigrations(opts.migrationsDir)) {
      const prior = seen.get(m.version);
      if (prior) {
        if (prior !== m.checksum) {
          throw new Error(
            `Migration ${m.version} has already been applied but its file has changed ` +
              `(recorded ${prior}, file ${m.checksum}). Applied migrations are immutable — ` +
              `add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      log(`  → applying ${m.filename}`);
      const started = Date.now();
      await client.query('BEGIN');
      try {
        // Migrations read this to decide which role receives grants.
        await client.query(`SET LOCAL ct.app_role = '${opts.appRole.replace(/'/g, "''")}'`);
        await client.query(m.sql);
        const duration = Date.now() - started;
        await client.query(
          `INSERT INTO app.schema_migrations (version, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [m.version, m.checksum, duration],
        );
        await client.query('COMMIT');
        log(`    ✔ ${m.version} (${duration}ms)`);
        applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.filename} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

export async function migrationStatus(opts: MigratorOptions) {
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  try {
    const files = await loadMigrations(opts.migrationsDir);
    const { rows } = await client
      .query<{ version: string; applied_at: Date }>(
        `SELECT version, applied_at FROM app.schema_migrations ORDER BY version`,
      )
      .catch(() => ({ rows: [] as { version: string; applied_at: Date }[] }));
    const appliedSet = new Set(rows.map((r) => r.version));
    return files.map((f) => ({
      version: f.version,
      applied: appliedSet.has(f.version),
      applied_at: rows.find((r) => r.version === f.version)?.applied_at ?? null,
    }));
  } finally {
    await client.end();
  }
}
