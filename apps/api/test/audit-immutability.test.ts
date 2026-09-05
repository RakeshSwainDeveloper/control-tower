/**
 * Audit trail immutability — FR-502, BR-10.
 *
 * "Append-only, not deletable by any role including platform staff."
 * That claim is only true if it is enforced by database grants, so this test
 * asserts the grants themselves. A future migration that widens them fails here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb, createTenant, dropTenant, type Tenant } from './helpers.js';

describe('audit_log immutability', () => {
  let db: Kysely<DB>;
  let fixtures: Kysely<DB>;
  let tenant: Tenant;

  beforeAll(async () => {
    fixtures = migratorDb();
    db = appDb();
    tenant = await createTenant(fixtures, 'audit');
  });

  afterAll(async () => {
    await dropTenant(fixtures, tenant.orgId);
    await db.destroy();
    await fixtures.destroy();
  });

  it('the application role holds INSERT and SELECT only', async () => {
    const rows = await withoutTenant(db, 'grant inspection', async (trx) => {
      const r = await sql<{ privilege_type: string }>`
        SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'app' AND table_name = 'audit_log'
          AND grantee = current_user
        ORDER BY privilege_type
      `.execute(trx);
      return r.rows.map((x) => x.privilege_type);
    });
    expect(rows.sort()).toEqual(['INSERT', 'SELECT']);
    expect(rows).not.toContain('UPDATE');
    expect(rows).not.toContain('DELETE');
    expect(rows).not.toContain('TRUNCATE');
  });

  it('accepts an append and records the responsibility exercised', async () => {
    const entityId = tenant.companyId;
    await withTenant(db, { orgId: tenant.orgId }, (trx) =>
      trx
        .insertInto('app.audit_log')
        .values({
          org_id: tenant.orgId,
          entity_type: 'company',
          entity_id: entityId,
          action: 'create',
          responsibility_label: 'Company Admin',
          changes: JSON.stringify([{ field: 'name', old: null, new: 'Audit Default' }]),
        })
        .execute(),
    );

    const rows = await withTenant(db, { orgId: tenant.orgId }, (trx) =>
      trx.selectFrom('app.audit_log').selectAll().where('entity_id', '=', entityId).execute(),
    );
    expect(rows).toHaveLength(1);
    // FR-030: "Ramesh approved this" is ambiguous; "as Project Manager" is not.
    expect(rows[0]!.responsibility_label).toBe('Company Admin');
  });

  it('refuses UPDATE at the database level', async () => {
    await expect(
      withTenant(db, { orgId: tenant.orgId }, (trx) =>
        trx.updateTable('app.audit_log').set({ action: 'delete' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses DELETE at the database level', async () => {
    await expect(
      withTenant(db, { orgId: tenant.orgId }, (trx) =>
        trx.deleteFrom('app.audit_log').execute(),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is partitioned, with partitions named after the parent table', async () => {
    const rows = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ relname: string }>`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relispartition AND c.relkind = 'r'
          AND c.relname LIKE 'audit_log%'
        ORDER BY c.relname
      `.execute(trx);
      return r.rows.map((x) => x.relname);
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const name of rows) expect(name).toMatch(/^audit_log_\d{6}$/);
  });
});
