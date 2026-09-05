/**
 * The claim-then-verify backbone, and the quantity ledger.
 *
 * Two properties this suite exists to protect:
 *
 *  1. THE CLAIM SURVIVES VERIFICATION. reported_qty and verified_qty are
 *     separate persisted columns (change C-3). An adjustment that overwrote the
 *     claim would erase the reported-vs-verified gap — the signal the whole
 *     product is built on (FR-146).
 *
 *  2. PERCENTAGE IS DERIVED. There is no percentage column and no percentage
 *     field. "80% complete" is an opinion; "412 of 515 sqm" is a fact.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withoutTenant, type DB } from '@ct/db';
import { appDb } from './helpers.js';

describe('progress & quantity ledger — schema guarantees', () => {
  let db: Kysely<DB>;
  beforeAll(() => { db = appDb(); });
  afterAll(async () => { await db.destroy(); });

  it('reported_qty and verified_qty are SEPARATE persisted columns', async () => {
    const cols = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ column_name: string; is_nullable: string; is_generated: string }>`
        SELECT column_name, is_nullable, is_generated
        FROM information_schema.columns
        WHERE table_schema='app' AND table_name='progress_entries'
          AND column_name IN ('reported_qty','verified_qty')
        ORDER BY column_name
      `.execute(trx);
      return r.rows;
    });
    expect(cols.map((c) => c.column_name)).toEqual(['reported_qty', 'verified_qty']);
    // The claim is mandatory and never derived; the verification is optional
    // until someone does it.
    expect(cols.find((c) => c.column_name === 'reported_qty')!.is_nullable).toBe('NO');
    expect(cols.find((c) => c.column_name === 'verified_qty')!.is_nullable).toBe('YES');
    for (const c of cols) expect(c.is_generated).toBe('NEVER');
  });

  it('there is NO percentage column anywhere in the progress model', async () => {
    // A column invites a value; a value invites an opinion. FR-142.
    const found = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ table_name: string; column_name: string }>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='app'
          AND table_name IN ('progress_entries','quantity_ledger','work_items')
          AND (column_name LIKE '%percent%' OR column_name LIKE '%_pct%')
      `.execute(trx);
      return r.rows;
    });
    expect(found, `percentage columns found: ${JSON.stringify(found)}`).toEqual([]);
  });

  it('an adjustment or rejection cannot be recorded without a reason', async () => {
    const checks = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ conname: string; def: string }>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relname='progress_entries' AND con.contype='c'
      `.execute(trx);
      return r.rows;
    });
    const names = checks.map((c) => c.conname);
    expect(names).toContain('progress_adjust_needs_reason');
    expect(names).toContain('progress_over_execution_needs_reason');
    expect(names).toContain('progress_verified_has_qty');
  });

  it('progress entries cannot cross project boundaries', async () => {
    // The lesson of migration 0019, applied to the new tables: RLS confines a
    // row to the tenant, not to the project.
    const fks = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ conname: string }>`
        SELECT con.conname FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relname='progress_entries' AND con.contype='f'
      `.execute(trx);
      return r.rows.map((x) => x.conname);
    });
    expect(fks).toContain('progress_work_item_same_project');
    expect(fks).toContain('progress_location_same_project');
  });

  it('the quantity ledger derives is_billable rather than trusting a caller', async () => {
    // FR-156: only measurement-sourced VERIFIED quantities are billable. A
    // stored-and-set column would drift; a generated one cannot.
    const col = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ is_generated: string; generation_expression: string }>`
        SELECT is_generated, generation_expression
        FROM information_schema.columns
        WHERE table_schema='app' AND table_name='quantity_ledger' AND column_name='is_billable'
      `.execute(trx);
      return r.rows[0];
    });
    expect(col?.is_generated).toBe('ALWAYS');
    expect(col!.generation_expression).toMatch(/measurement/);
    expect(col!.generation_expression).toMatch(/verified/);
  });

  it('the ledger is partitioned and RLS-secured, partitions included', async () => {
    const rows = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ relname: string; rls: boolean; forced: boolean; pol: number }>`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) AS pol
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND c.relname LIKE 'quantity_ledger%' AND c.relkind IN ('r','p')
      `.execute(trx);
      return r.rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r.rls, `${r.relname}: RLS off`).toBe(true);
      expect(r.forced, `${r.relname}: RLS not forced`).toBe(true);
      expect(r.pol, `${r.relname}: no policy`).toBeGreaterThan(0);
    }
  });

  it('a submitted daily report locks its entries at the database level', async () => {
    const trg = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ tgname: string }>`
        SELECT t.tgname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='app' AND c.relname='progress_entries' AND NOT t.tgisinternal
      `.execute(trx);
      return r.rows.map((x) => x.tgname);
    });
    // In the service layer this is a rule someone can forget. Here it is a fact.
    expect(trg).toContain('progress_entries_lock_guard');
  });

  it('only ONE original report can exist per project per day', async () => {
    const idx = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname='app' AND indexname='daily_reports_one_original_per_day'
      `.execute(trx);
      return r.rows[0]?.indexdef ?? '';
    });
    expect(idx).toMatch(/UNIQUE/);
    // Amendments and merge twins are deliberately exempt: both must be able to
    // coexist with the original.
    expect(idx).toMatch(/amends_report_id IS NULL/);
    expect(idx).toMatch(/merged_from_report_id IS NULL/);
  });
});
