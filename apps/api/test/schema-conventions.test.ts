/**
 * Schema conventions, asserted rather than remembered.
 *
 * Every one of these caught a real defect during Phase 1–3, or guards a rule
 * that a future migration could silently break. They read the live catalogue,
 * so they fail on the migration that breaks them rather than on the request
 * that trips over it months later.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb } from './helpers.js';

describe('schema conventions', () => {
  let db: Kysely<DB>;
  beforeAll(() => { db = appDb(); });
  afterAll(async () => { await db.destroy(); });

  it('every touch_row trigger has the columns that trigger writes', async () => {
    // Found by a 500 on import confirmation: import_jobs had the trigger and
    // no updated_at. The trigger sets updated_at and version, so a table
    // carrying it must have both.
    const bad = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ table_name: string; missing: string }>`
        SELECT c.relname AS table_name, needed.col AS missing
        FROM pg_trigger t
        JOIN pg_class c   ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p    ON p.oid = t.tgfoid
        CROSS JOIN (VALUES ('updated_at'), ('version')) AS needed(col)
        WHERE n.nspname = 'app' AND NOT t.tgisinternal AND p.proname = 'touch_row'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'app' AND col.table_name = c.relname
              AND col.column_name = needed.col
          )
      `.execute(trx);
      return r.rows;
    });
    expect(bad, `tables missing columns their trigger writes: ${JSON.stringify(bad)}`)
      .toEqual([]);
  });

  it('every org-scoped table indexes org_id as the LEADING column', async () => {
    // A trailing org_id is not a tenant index: the planner cannot use it to
    // narrow to a tenant, so every scoped list degrades to a scan as the table
    // grows. D-1.
    const bad = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ table_name: string }>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r','p') AND NOT c.relispartition
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema='app' AND col.table_name=c.relname
              AND col.column_name='org_id' AND col.is_nullable='NO'
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
            WHERE i.indrelid = c.oid AND a.attname = 'org_id'
          )
      `.execute(trx);
      return r.rows.map((x) => x.table_name);
    });
    expect(bad, `org-scoped tables with no org_id-leading index: ${bad.join(', ')}`)
      .toEqual([]);
  });

  it('no money value can be written anywhere in the MVP', async () => {
    // PRODUCT_REVIEW.md §14: the no-money boundary is the largest single reason
    // the MVP is ~52 engineer-weeks. Columns exist so Phase 3 attaches by
    // addition; CHECK constraints keep "declared but unused" enforceable rather
    // than aspirational.
    const guarded = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ table_name: string; constraint_name: string }>`
        SELECT rel.relname AS table_name, con.conname AS constraint_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'app' AND con.contype = 'c'
          AND con.conname LIKE '%no_money%'
      `.execute(trx);
      return r.rows;
    });
      // projects.contract_value/currency, work_items.planned_rate, and
      // approval_instances.amount/currency — the last added in Phase 6.
      //
      // Asserted EXACTLY, not as a superset: a new money-bearing column added
      // without its CHECK would slip past a superset assertion, and that is the
      // precise mistake the no-money boundary exists to prevent.
      expect(guarded.map((g) => g.table_name).sort())
        .toEqual(['approval_instances', 'projects', 'work_items']);
  });

  it('every table that records who acted can also record AS WHAT', async () => {
    // FR-030. A created_by with no created_by_grant_id produces "Ramesh created
    // this", which is ambiguous the moment anyone holds two responsibilities —
    // and it cannot be backfilled.
    const bad = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ table_name: string }>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relkind='r' AND NOT c.relispartition
          AND c.relname IN ('projects','locations','work_items')
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema='app' AND col.table_name=c.relname
              AND col.column_name='created_by_grant_id'
          )
      `.execute(trx);
      return r.rows.map((x) => x.table_name);
    });
    expect(bad, `operational tables with no created_by_grant_id: ${bad.join(', ')}`)
      .toEqual([]);
  });

  it('the location tree is indexed for subtree queries', async () => {
    // path <@ ancestor runs on every location-filtered list. Without a GIST
    // index it is a sequential scan of the whole tree.
    const hasGist = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relname='locations' AND am.amname='gist'
      `.execute(trx);
      return Number(r.rows[0]!.n);
    });
    expect(hasGist).toBeGreaterThan(0);
  });
});

describe('cross-project integrity', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;
  let orgId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = appDb();
    owner = migratorDb();

    const org = await withoutTenant(owner, 'fixture setup precedes tenant context', (trx) =>
      trx.insertInto('app.organizations').values({
        legal_name: 'XProj Ltd', display_name: 'XProj',
        slug: `xproj-${Date.now().toString(36)}`,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    orgId = org.id;

    await withTenant(owner, { orgId }, async (trx) => {
      const company = await trx.insertInto('app.companies')
        .values({ org_id: orgId, name: 'XProj', is_default: true })
        .returning('id').executeTakeFirstOrThrow();
      const user = await trx.insertInto('app.users').values({
        org_id: orgId, name: 'Fixture User', email: `x${Date.now()}@x.test`, status: 'active',
      }).returning('id').executeTakeFirstOrThrow();
      const unit = await trx.insertInto('app.units').values({
        org_id: orgId, code: 'sqm', name: 'Square metre', dimension: 'area',
      }).returning('id').executeTakeFirstOrThrow();

      for (const tag of ['a', 'b'] as const) {
        const p = await trx.insertInto('app.projects').values({
          org_id: orgId, company_id: company.id,
          code: `X${tag.toUpperCase()}`, name: `Project ${tag}`,
          accountable_manager_user_id: user.id, commercial_owner_user_id: user.id,
        }).returning('id').executeTakeFirstOrThrow();
        ids[`project_${tag}`] = p.id;

        const loc = await trx.insertInto('app.locations').values({
          org_id: orgId, project_id: p.id, code: `L${tag}`, name: `Location ${tag}`,
          path: sql`''::ltree` as never,
        }).returning('id').executeTakeFirstOrThrow();
        ids[`location_${tag}`] = loc.id;

        const wi = await trx.insertInto('app.work_items').values({
          org_id: orgId, project_id: p.id, code: `W${tag}`,
          description: `Work ${tag}`, unit_id: unit.id, planned_qty: '1000',
        }).returning('id').executeTakeFirstOrThrow();
        ids[`work_item_${tag}`] = wi.id;
      }
    });
  });

  afterAll(async () => {
    await withTenant(owner, { orgId }, async (trx) => {
      await trx.deleteFrom('app.work_item_locations').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.work_items').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.locations').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.projects').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.units').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.users').where('org_id', '=', orgId).execute();
      await trx.deleteFrom('app.companies').where('org_id', '=', orgId).execute();
    });
    await withoutTenant(owner, 'teardown', (trx) =>
      trx.deleteFrom('app.organizations').where('id', '=', orgId).execute());
    await db.destroy();
    await owner.destroy();
  });

  it('allocating within one project is allowed', async () => {
    await withTenant(db, { orgId }, (trx) =>
      trx.insertInto('app.work_item_locations').values({
        org_id: orgId, project_id: ids['project_a']!,
        work_item_id: ids['work_item_a']!, location_id: ids['location_a']!,
        planned_qty: '10',
      }).execute(),
    );
    const rows = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.work_item_locations').selectAll()
        .where('work_item_id', '=', ids['work_item_a']!).execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it("REFUSES a location from another project", async () => {
    // RLS confines both rows to the tenant, and both DO belong to this tenant —
    // so only the composite FK stops planned quantity from one project rolling
    // up into another. Found in Phase 3 by trying it.
    await expect(
      withTenant(db, { orgId }, (trx) =>
        trx.insertInto('app.work_item_locations').values({
          org_id: orgId, project_id: ids['project_a']!,
          work_item_id: ids['work_item_a']!,
          location_id: ids['location_b']!,      // ← other project
          planned_qty: '10',
        }).execute(),
      ),
    ).rejects.toThrow(/wil_location_same_project|foreign key/i);
  });

  it("REFUSES a work item from another project", async () => {
    await expect(
      withTenant(db, { orgId }, (trx) =>
        trx.insertInto('app.work_item_locations').values({
          org_id: orgId, project_id: ids['project_a']!,
          work_item_id: ids['work_item_b']!,    // ← other project
          location_id: ids['location_a']!,
          planned_qty: '10',
        }).execute(),
      ),
    ).rejects.toThrow(/wil_work_item_same_project|foreign key/i);
  });

  it('REFUSES a location parented into another project', async () => {
    await expect(
      withTenant(db, { orgId }, (trx) =>
        trx.insertInto('app.locations').values({
          org_id: orgId, project_id: ids['project_a']!,
          parent_id: ids['location_b']!,        // ← other project
          code: 'BAD', name: 'Bad', path: sql`''::ltree` as never,
        }).execute(),
      ),
    ).rejects.toThrow(/locations_parent_same_project|foreign key|not found/i);
  });
});
