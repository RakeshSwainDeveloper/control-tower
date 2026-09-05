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
  /* ── Phase 6 regression: privileges, not just RLS ───────────────── */

  it('every partition carries EXACTLY its parent\'s privileges for ct_app', async () => {
    // Phase 6 found the second half of the Phase 1 lesson: a partition does not
    // inherit its parent's GRANTS either. approval_decisions was append-only
    // through the parent and fully writable through the partition —
    //
    //     UPDATE app.approval_decisions        → permission denied
    //     UPDATE app.approval_decisions_202609 → UPDATE 0
    //
    // Asserted across the WHOLE catalogue rather than for the tables known to
    // be append-only today, because the next append-only table is the one that
    // will be forgotten.
    const mismatches = await withoutTenant(owner, 'catalogue inspection', async (trx) => {
      const r = await sql<{ partition: string; parent: string; extra: string }>`
        WITH parts AS (
          SELECT c.relname AS partition, p.relname AS parent
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relkind = 'r'
        ), privs AS (
          SELECT parts.partition, parts.parent, x.priv,
                 has_table_privilege('ct_app', format('app.%I', parts.partition)::regclass, x.priv) AS on_part,
                 has_table_privilege('ct_app', format('app.%I', parts.parent)::regclass,    x.priv) AS on_parent
          FROM parts,
               unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS x(priv)
        )
        SELECT partition, parent, string_agg(priv, ',' ORDER BY priv) AS extra
        FROM privs WHERE on_part <> on_parent
        GROUP BY partition, parent ORDER BY 1
      `.execute(trx);
      return r.rows;
    });
    expect(
      mismatches,
      `partitions whose ct_app privileges differ from their parent:\n` +
        mismatches.map((m) => `  ${m.partition} vs ${m.parent}: ${m.extra}`).join('\n'),
    ).toEqual([]);
  });

  it('a partition created in the FUTURE is locked down at creation, not by a later sweep', async () => {
    // 0003 revoked over the partitions that existed at migration time and its
    // comment claimed that stopped future ones being created wider. It did not:
    // a new partition takes its ACL from ALTER DEFAULT PRIVILEGES. The audit
    // trail would have become mutable at the first month roll the worker did.
    await withoutTenant(db, 'partition maintenance', async (trx) => {
      await sql`SELECT app.ensure_month_partition('app.audit_log'::regclass, ${PROBE_MONTH}::date)`
        .execute(trx);
    });

    const grants = await withoutTenant(owner, 'catalogue inspection', async (trx) => {
      const r = await sql<{ privilege_type: string }>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='app' AND grantee='ct_app' AND table_name=${PROBE_NAME}
        ORDER BY privilege_type
      `.execute(trx);
      return r.rows.map((x) => x.privilege_type);
    });
    expect(grants).toEqual(['INSERT', 'SELECT']);

    // And prove it, rather than trusting the catalogue: ct_app attempts the
    // write that used to succeed.
    await expect(
      withoutTenant(db, 'tamper probe', (trx) =>
        sql.raw(`UPDATE app.${PROBE_NAME} SET action = 'delete' WHERE false`).execute(trx)),
    ).rejects.toThrow(/permission denied/i);
  });
});
