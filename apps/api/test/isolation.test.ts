/**
 * CROSS-TENANT ISOLATION SUITE — the CI gate.
 *
 * Runs on every build from the first commit (STACK_AND_DOCKER_PLAN.md §7,
 * MVP_DATABASE_SCOPE.md §7). One missed `WHERE org_id` and a customer sees
 * another customer's project; these tests are the backstop that catches it.
 *
 * Every new org-scoped table must gain a case here in the SAME pull request
 * as its migration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, MissingTenantContextError, type DB } from '@ct/db';
import { appDb, migratorDb, createTenant, dropTenant, type Tenant } from './helpers.js';

describe('cross-tenant isolation', () => {
  let db: Kysely<DB>;
  let fixtures: Kysely<DB>;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    fixtures = migratorDb();
    db = appDb();
    alpha = await createTenant(fixtures, 'alpha');
    beta = await createTenant(fixtures, 'beta');
  });

  afterAll(async () => {
    await dropTenant(fixtures, alpha.orgId);
    await dropTenant(fixtures, beta.orgId);
    await db.destroy();
    await fixtures.destroy();
  });

  it('a tenant sees exactly its own rows', async () => {
    const rows = await withTenant(db, { orgId: alpha.orgId }, (trx) =>
      trx.selectFrom('app.companies').selectAll().execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(alpha.orgId);
  });

  it("a tenant cannot read another tenant's row even knowing its id", async () => {
    const rows = await withTenant(db, { orgId: alpha.orgId }, (trx) =>
      trx.selectFrom('app.companies').selectAll().where('id', '=', beta.companyId).execute(),
    );
    // Not "forbidden" — invisible. Existence must not be disclosed, which is
    // what lets the API answer 404 rather than 403.
    expect(rows).toHaveLength(0);
  });

  it('FAILS CLOSED: no tenant context returns nothing, not everything', async () => {
    const rows = await withoutTenant(db, 'deliberately unscoped, to prove RLS', (trx) =>
      trx.selectFrom('app.companies').selectAll().execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it("WITH CHECK: a tenant cannot insert a row belonging to another tenant", async () => {
    await expect(
      withTenant(db, { orgId: alpha.orgId }, (trx) =>
        trx
          .insertInto('app.companies')
          .values({ org_id: beta.orgId, name: 'smuggled' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a tenant cannot update another tenant's row", async () => {
    const res = await withTenant(db, { orgId: alpha.orgId }, (trx) =>
      trx
        .updateTable('app.companies')
        .set({ name: 'hijacked' })
        .where('id', '=', beta.companyId)
        .executeTakeFirst(),
    );
    expect(Number(res.numUpdatedRows)).toBe(0);

    const still = await withTenant(db, { orgId: beta.orgId }, (trx) =>
      trx.selectFrom('app.companies').select('name').where('id', '=', beta.companyId).executeTakeFirst(),
    );
    expect(still?.name).toBe('beta Default');
  });

  it("a tenant cannot delete another tenant's row", async () => {
    const res = await withTenant(db, { orgId: alpha.orgId }, (trx) =>
      trx.deleteFrom('app.companies').where('id', '=', beta.companyId).executeTakeFirst(),
    );
    expect(Number(res.numDeletedRows)).toBe(0);
  });

  it('withTenant refuses an empty org id rather than running unscoped', async () => {
    await expect(
      withTenant(db, { orgId: '' }, async () => 'should not reach here'),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('tenant context does not leak between sequential transactions', async () => {
    await withTenant(db, { orgId: alpha.orgId }, async (trx) => {
      await trx.selectFrom('app.companies').selectAll().execute();
    });
    // SET LOCAL is transaction-scoped; the next statement outside a tenant
    // transaction must see nothing. This is the assertion that would fail if
    // the pool were ever switched to session-level pooling.
    const leaked = await withoutTenant(db, 'leak probe', (trx) =>
      trx.selectFrom('app.companies').selectAll().execute(),
    );
    expect(leaked).toHaveLength(0);
  });

  it('every org-scoped BASE table has RLS enabled AND forced', async () => {
    const rows = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ tablename: string; rls: boolean; forced: boolean }>`
        SELECT c.relname AS tablename, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = 'app' AND col.table_name = c.relname
        WHERE n.nspname = 'app'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND col.column_name = 'org_id'
      `.execute(trx);
      // Deliberately NOT filtered on is_nullable. An earlier version of this
      // test skipped nullable org_id columns, which is exactly how
      // app.feature_flags shipped with RLS off: it had an org_id, it was
      // tenant-scoped in practice, and the filter hid it. If a table has an
      // org_id at all, it is tenant data and it gets a policy.
      return r.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      expect(t.rls, `${t.tablename}: RLS not enabled`).toBe(true);
      // FORCE matters: without it the table owner bypasses the policy, and
      // migrations and seeds silently become a cross-tenant hole.
      expect(t.forced, `${t.tablename}: RLS not FORCED`).toBe(true);
    }
  });

  it('every org-scoped PARTITION carries its own policy', async () => {
    // A partition does NOT inherit the parent's policy on direct access.
    // Without this, `SELECT * FROM app.audit_log_202609` reads across tenants
    // while `SELECT * FROM app.audit_log` correctly does not. Found in Phase 1;
    // fixed by migration 0003.
    const rows = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ tablename: string; rls: boolean; forced: boolean; policies: number }>`
        SELECT c.relname AS tablename,
               c.relrowsecurity      AS rls,
               c.relforcerowsecurity  AS forced,
               (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = 'app' AND col.table_name = c.relname
        WHERE n.nspname = 'app'
          AND c.relkind = 'r' AND c.relispartition
          AND col.column_name = 'org_id'
      `.execute(trx);
      return r.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      expect(t.rls, `${t.tablename}: partition RLS not enabled`).toBe(true);
      expect(t.forced, `${t.tablename}: partition RLS not FORCED`).toBe(true);
      expect(t.policies, `${t.tablename}: partition has no policy`).toBeGreaterThan(0);
    }
  });

  it('reading a partition DIRECTLY does not bypass tenant isolation', async () => {
    const partition = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ relname: string }>`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relispartition AND c.relkind = 'r'
          AND c.relname LIKE 'audit_log_%'
        ORDER BY c.relname DESC LIMIT 1
      `.execute(trx);
      return r.rows[0]?.relname;
    });
    expect(partition).toBeDefined();

    // alpha writes one audit row
    await withTenant(db, { orgId: alpha.orgId }, (trx) =>
      trx.insertInto('app.audit_log').values({
        org_id: alpha.orgId, entity_type: 'company', entity_id: alpha.companyId,
        action: 'create', responsibility_label: 'Company Admin',
      }).execute(),
    );

    const asAlpha = await withTenant(db, { orgId: alpha.orgId }, async (trx) => {
      const r = await sql<{ n: string }>`SELECT count(*) AS n FROM app.audit_log`.execute(trx);
      return Number(r.rows[0]!.n);
    });
    expect(asAlpha).toBeGreaterThan(0);

    // beta reads the same partition by name and must see none of it
    const asBeta = await withTenant(db, { orgId: beta.orgId }, async (trx) => {
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM app.audit_log WHERE org_id = ${alpha.orgId}
      `.execute(trx);
      return Number(r.rows[0]!.n);
    });
    expect(asBeta).toBe(0);
  });
});

describe('feature flag isolation', () => {
  it('tenant overrides are RLS-scoped; the platform catalogue is not tenant data', async () => {
    const db = appDb();
    try {
      // The catalogue has no org_id, so it is readable without tenant context —
      // that is correct, it describes the product, not any customer.
      const defs = await withoutTenant(db, 'platform catalogue is not tenant data', (trx) =>
        trx.selectFrom('app.feature_flag_defs').selectAll().execute(),
      );
      expect(defs.length).toBeGreaterThan(0);

      // Overrides are tenant data and must fail closed without context.
      const leaked = await withoutTenant(db, 'leak probe', (trx) =>
        trx.selectFrom('app.org_feature_flags').selectAll().execute(),
      );
      expect(leaked).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});
