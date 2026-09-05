import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

export interface DbConfig {
  connectionString: string;
  poolMax?: number;
  onSlowQuery?: (durationMs: number, sql: string) => void;
  slowQueryMs?: number;
}

/** Postgres returns NUMERIC as a string to preserve precision. Keep it that
 *  way — quantities must never become JS floats (D-9). */
pg.types.setTypeParser(1700, (v) => v);
/** BIGINT likewise. */
pg.types.setTypeParser(20, (v) => v);

export function createDb(cfg: DbConfig): Kysely<DB> {
  const pool = new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.poolMax ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Transaction-level context via SET LOCAL means we must never reuse a
    // connection mid-transaction; node-pg checks a connection out per client
    // which satisfies this. See tenant-context.ts.
    application_name: 'control-tower',
  });

  const slowMs = cfg.slowQueryMs ?? 500;

  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log(event: LogEvent) {
      if (event.level === 'error') {
        console.error({ msg: 'query failed', sql: event.query.sql, err: event.error });
      } else if (cfg.onSlowQuery) {
        const ms = Number(event.queryDurationMillis);
        if (ms >= slowMs) cfg.onSlowQuery(ms, event.query.sql);
      }
    },
  });
}
