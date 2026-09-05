/**
 * Partition maintenance must be executable BY THE APPLICATION ROLE.
 *
 * Regression test for a Phase 1 defect: ensure_month_partition() needed table
 * ownership (CREATE TABLE ... PARTITION OF, ALTER TABLE ... ENABLE RLS), but
 * the worker connects as ct_app. Maintenance silently never ran. Partitions
 * existed only because migrations created them, and they stopped at 2027-01 —
 * after which every audited write in the product would fail, because the audit
 * row is written in the same transaction as the change (FR-508).
 *
 * Fixed by migration 0004 (SECURITY DEFINER + pinned search_path + a guard).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb } from './helpers.js';

const PROBE_MONTH = '2029-11-01';
const PROBE_NAME = 'audit_log_202911';

describe('partition maintenance privileges', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;

  beforeAll(() => {
    db = appDb();       // ct_app — the role the worker actually uses
    owner = migratorDb();
  });

  afterAll(async () => {
    await withoutTenant(owner, 'probe cleanup', async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS app.${PROBE_NAME}`).execute(trx);
    });
    await db.destroy();
    await owner.destroy();
  });

  it('the application role can create a partition', async () => {
    const name = await withoutTenant(db, 'partition maintenance is tenant-less DDL', async (trx) => {
      const r = await sql<{ ensure_month_partition: string }>`
        SELECT app.ensure_month_partition('app.audit_log'::regclass, ${PROBE_MONTH}::date)
      `.execute(trx);
      return r.rows[0]!.ensure_month_partition;
    });
    expect(name).toBe(PROBE_NAME);
  });

  it('the partition it creates is RLS-protected immediately', async () => {
    // A partition that exists for even one request without a policy is a
    // cross-tenant read window, so protection must be atomic with creation.
    const row = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ rls: boolean; forced: boolean; policies: number }>`
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname='app' AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relname = ${PROBE_NAME}
      `.execute(trx);
      return r.rows[0];
    });
    expect(row?.rls).toBe(true);
    expect(row?.forced).toBe(true);
    expect(row?.policies).toBeGreaterThan(0);
  });

  it('is idempotent', async () => {
    const again = await withoutTenant(db, 'idempotency check', async (trx) => {
      const r = await sql<{ ensure_month_partition: string }>`
        SELECT app.ensure_month_partition('app.audit_log'::regclass, ${PROBE_MONTH}::date)
      `.execute(trx);
      return r.rows[0]!.ensure_month_partition;
    });
    expect(again).toBe(PROBE_NAME);
  });

  it('SECURITY DEFINER cannot be abused to touch a non-partitioned table', async () => {
    // The function runs with the owner's rights, so it must not become a
    // general "create a table anywhere" primitive.
    await expect(
      withoutTenant(db, 'abuse probe', async (trx) => {
        await sql`SELECT app.ensure_month_partition('app.companies'::regclass, ${PROBE_MONTH}::date)`
          .execute(trx);
      }),
    ).rejects.toThrow(/not a partitioned table in schema app/i);
  });

  it('coverage extends at least 2 months into the future', async () => {
    // The worker runs this hourly. If coverage ever falls to the current month,
    // the next month rolls over into failed inserts on every audited write.
    const months = await withoutTenant(db, 'coverage check', async (trx) => {
      const r = await sql<{ relname: string }>`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relispartition AND c.relkind='r'
          AND c.relname ~ '^audit_log_[0-9]{6}$'
      `.execute(trx);
      return r.rows.map((x) => x.relname.slice(-6)).sort();
    });
    const now = new Date();
    const stamp = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    for (let i = 0; i <= 2; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      expect(months, `missing partition for ${stamp(d)}`).toContain(stamp(d));
    }
  });
});
