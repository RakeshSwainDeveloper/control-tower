import { Controller, Get, Inject } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@ct/db';
import { DB_TOKEN, ENV_TOKEN } from '../../common/tokens.js';
import { Public } from '../auth/public.decorator.js';
import type { Env } from '../../config/env.js';

interface CheckResult { status: 'up' | 'down'; latency_ms?: number; error?: string }

@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  /** Liveness — is the process up. Used by the container healthcheck. */
  @Public()
  @Get()
  async health() {
    const db = await this.checkDb();
    const ok = db.status === 'up';
    return {
      status: ok ? 'ok' : 'degraded',
      service: 'control-tower-api',
      env: this.env.NODE_ENV,
      time: new Date().toISOString(),
      checks: { database: db },
    };
  }

  /** Readiness — including migration state. A pod that has not migrated
   *  must not receive traffic. */
  @Public()
  @Get('ready')
  async ready() {
    const db = await this.checkDb();
    let migrations: { applied: number; latest: string | null } = { applied: 0, latest: null };
    if (db.status === 'up') {
      const rows = await this.db
        .selectFrom('app.schema_migrations')
        .select(['version'])
        .orderBy('version', 'desc')
        .execute();
      migrations = { applied: rows.length, latest: rows[0]?.version ?? null };
    }
    return {
      status: db.status === 'up' && migrations.applied > 0 ? 'ready' : 'not_ready',
      checks: { database: db, migrations },
    };
  }

  private async checkDb(): Promise<CheckResult> {
    const t0 = Date.now();
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'up', latency_ms: Date.now() - t0 };
    } catch (err) {
      return { status: 'down', error: (err as Error).message };
    }
  }
}
