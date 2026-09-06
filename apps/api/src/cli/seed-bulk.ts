import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { AppModule } from '../app.module.js';
import { DB_TOKEN } from '../common/tokens.js';

/**
 * Twelve months of realistic traffic, for the P8 performance gate.
 *
 * `STACK_AND_DOCKER_PLAN.md` §6 requires the dashboard to load in under three
 * seconds with a year of data. A dashboard measured against the 12 rows the
 * demo seed creates has been measured against nothing.
 *
 * What a real site produces in a year, roughly: a supervisor records 20–30
 * quantities a day, six days a week; each day closes with one report; issues
 * arrive at a few a week and mostly get closed; every one of those writes an
 * audit row, often several.
 *
 * Written with multi-row inserts rather than an ORM loop — 8,000 round trips
 * to seed a fixture is its own kind of waste, and the point of this file is to
 * be run often.
 */
const WORKING_DAYS = 300;          // ~6 days a week for a year
const ENTRIES_PER_DAY = 25;
const ISSUES_PER_WEEK = 4;
const BATCH = 500;

/** Deterministic PRNG: a performance number that moves because the fixture
 *  moved is not a performance number. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const db = app.get<Kysely<DB>>(DB_TOKEN);
  const started = Date.now();

  const org = await sql<{ id: string }>`
    SELECT id FROM app.organizations ORDER BY created_at LIMIT 1
  `.execute(db).then((r) => r.rows[0]);
  if (!org) throw new Error('No organization. Run `make seed` first.');

  await withTenant(db, { orgId: org.id }, async (trx) => {
    const project = await trx.selectFrom('app.projects').select(['id', 'code'])
      .orderBy('code').executeTakeFirst();
    if (!project) throw new Error('No project. Run `make seed` first.');

    const [locations, workItems, users] = await Promise.all([
      trx.selectFrom('app.locations as l')
        .leftJoin('app.locations as c', 'c.parent_id', 'l.id')
        .select(['l.id']).where('c.id', 'is', null).execute(),
      trx.selectFrom('app.work_items').select(['id', 'unit_id'])
        .where('is_active', '=', true).execute(),
      trx.selectFrom('app.users').select(['id', 'name']).execute(),
    ]);
    if (locations.length === 0 || workItems.length === 0) {
      throw new Error('The project has no locations or work items.');
    }

    const supervisor = users.find((u) => u.name.startsWith('Ramesh')) ?? users[0]!;
    const engineer = users.find((u) => u.name.startsWith('Anita')) ?? users[0]!;
    const pm = users.find((u) => u.name.startsWith('Vikram')) ?? users[0]!;

    // The grant each person acts under. Without it the fixture writes rows
    // with no responsibility, and the verification-gap report's "As" column —
    // the FR-030 column — comes out blank on the only data anyone will look at.
    const allGrants = await trx.selectFrom('app.role_grants')
      .select(['id', 'user_id', 'responsibility_label']).execute();
    const grantFor = (uid: string) => allGrants.find((g) => g.user_id === uid);

    const rand = rng(20260906);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const day = (back: number) =>
      new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

    console.log(`\n  Seeding ${WORKING_DAYS} days into ${project.code} …`);

    /* ── Daily reports, one per day ───────────────────────────── */
    const reports: Record<string, string> = {};
    for (let i = 0; i < WORKING_DAYS; i += BATCH) {
      const rows = [];
      for (let d = i; d < Math.min(i + BATCH, WORKING_DAYS); d++) {
        rows.push({
          org_id: org.id, project_id: project.id,
          report_date: day(d + 1),
          weather: pick(['Clear', 'Cloudy', 'Light rain', 'Very hot']),
          state_class: 'approved' as const,
          submitted_by: supervisor.id,
          submitted_at: new Date(Date.now() - (d + 1) * 86_400_000),
          locked_at: new Date(Date.now() - (d + 1) * 86_400_000),
        });
      }
      const made = await trx.insertInto('app.daily_reports').values(rows)
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'report_date']).execute();
      for (const m of made) {
        // report_date comes back as a Date, and String(Date) is
        // "Sat Sep 06 2026 …" — slicing that to 10 chars keyed the map on
        // "Sat Sep 06" and every lookup missed, so 7,500 entries were seeded
        // with no daily_report_id and the printable report was empty.
        const d = m.report_date as unknown;
        const key = d instanceof Date ? d.toISOString().slice(0, 10)
                                      : String(d).slice(0, 10);
        reports[key] = m.id;
      }
    }
    console.log(`  ✔ daily reports  ${Object.keys(reports).length}`);

    /* ── Progress entries ─────────────────────────────────────── */
    let entries = 0;
    for (let d = 0; d < WORKING_DAYS; d++) {
      const on = day(d + 1);
      const rows = [];
      for (let n = 0; n < ENTRIES_PER_DAY; n++) {
        const w = pick(workItems);
        const qty = (5 + Math.floor(rand() * 40)).toFixed(4);
        // Most claims get verified; some are adjusted, a few rejected, and the
        // most recent fortnight is still waiting — which is what a real backlog
        // looks like and what the verification gap is measured against.
        const roll = rand();
        const status = d < 14 ? 'reported'
          : roll < 0.82 ? 'verified'
          : roll < 0.94 ? 'adjusted'
          : 'rejected';
        const verified = status === 'verified' ? qty
          : status === 'adjusted' ? (Number(qty) * 0.85).toFixed(4)
          : status === 'rejected' ? '0.0000' : null;
        rows.push({
          org_id: org.id, project_id: project.id,
          daily_report_id: reports[on] ?? null,
          work_item_id: w.id, location_id: pick(locations).id,
          reported_qty: qty, verified_qty: verified,
          unit_id: w.unit_id, executed_on: on,
          contractor_label: pick(['Sharma & Co', 'Verma Builders', 'Nair Contracts']),
          reported_by: supervisor.id,
          reported_by_grant_id: grantFor(supervisor.id)?.id ?? null,
          reported_responsibility: grantFor(supervisor.id)?.responsibility_label ?? null,
          reported_at: new Date(Date.now() - (d + 1) * 86_400_000),
          verification_status: status as 'reported',
          verified_by: status === 'reported' ? null : engineer.id,
          verified_by_grant_id: status === 'reported' ? null
            : grantFor(engineer.id)?.id ?? null,
          verified_responsibility: status === 'reported' ? null
            : grantFor(engineer.id)?.responsibility_label ?? null,
          verified_at: status === 'reported' ? null
            : new Date(Date.now() - d * 86_400_000),
          verification_reason: status === 'adjusted' ? 'Measured on site'
            : status === 'rejected' ? 'Work not found at this location' : null,
        });
      }
      await trx.insertInto('app.progress_entries').values(rows).execute();
      entries += rows.length;
      if (d % 60 === 0 && d > 0) console.log(`    … ${entries} entries`);
    }
    console.log(`  ✔ progress       ${entries}`);

    /* ── Issues ───────────────────────────────────────────────── */
    const categories = await trx.selectFrom('app.master_data').select(['id'])
      .where('kind', '=', 'issue_category').execute();
    const issueCount = Math.floor((WORKING_DAYS / 6) * ISSUES_PER_WEEK);
    const issueRows = [];
    for (let n = 0; n < issueCount; n++) {
      const back = Math.floor(rand() * WORKING_DAYS) + 1;
      const roll = rand();
      const state = roll < 0.7 ? 'closed' : roll < 0.85 ? 'verified'
        : roll < 0.93 ? 'resolved' : 'in_progress';
      const raised = new Date(Date.now() - back * 86_400_000);
      issueRows.push({
        org_id: org.id, project_id: project.id,
        issue_number: `ISS/${project.code}/BULK/${String(n + 1).padStart(5, '0')}`,
        category_id: categories.length ? pick(categories).id : null,
        severity: (rand() < 0.08 ? 'critical' : rand() < 0.25 ? 'high'
          : rand() < 0.7 ? 'medium' : 'low') as 'medium',
        title: pick([
          'Honeycombing on column', 'Cracked tile', 'Plaster not to line',
          'Conduit fouling reinforcement', 'Water ponding on slab',
          'Shuttering not cleaned', 'Cover blocks missing',
        ]) + ` — ${pick(['C4', 'B2', 'A7', 'D1', 'E3'])}`,
        location_id: pick(locations).id,
        assignee_user_id: rand() < 0.85 ? engineer.id : null,
        due_date: day(back - 7),
        state_class: state as 'closed',
        raised_by: supervisor.id, raised_at: raised,
        raised_by_grant_id: grantFor(supervisor.id)?.id ?? null,
        raised_responsibility: grantFor(supervisor.id)?.responsibility_label ?? null,
        resolved_by: state === 'in_progress' ? null : engineer.id,
        resolved_at: state === 'in_progress' ? null
          : new Date(raised.getTime() + 2 * 86_400_000),
        resolution_note: state === 'in_progress' ? null : 'Rectified and re-checked',
        verified_by: state === 'closed' || state === 'verified' ? pm.id : null,
        verified_at: state === 'closed' || state === 'verified'
          ? new Date(raised.getTime() + 3 * 86_400_000) : null,
        closed_at: state === 'closed' ? new Date(raised.getTime() + 4 * 86_400_000) : null,
        reopen_count: rand() < 0.06 ? 1 : 0,
      });
    }
    for (let i = 0; i < issueRows.length; i += BATCH) {
      await trx.insertInto('app.issues').values(issueRows.slice(i, i + BATCH))
        .onConflict((oc) => oc.doNothing()).execute();
    }
    console.log(`  ✔ issues         ${issueRows.length}`);

    /* ── Audit rows ───────────────────────────────────────────────
       Written directly rather than through AuditService: this is a fixture,
       and 30,000 individual writes would take longer than the measurement
       they exist to support. The SHAPE matches what the service produces,
       including the responsibility label FR-030 requires. */
    /**
     * The audit log is partitioned by month, and maintenance only creates a
     * rolling window FORWARD. Backdating a year needs those months to exist,
     * so the fixture makes them.
     *
     * Worth noting beyond this file: restoring a year-old backup into a fresh
     * database would hit exactly this, and the runbook says so.
     */
    for (let m = 0; m <= 13; m++) {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - m);
      await sql`SELECT app.ensure_month_partition('app.audit_log'::regclass, ${d.toISOString().slice(0, 10)}::date)`
        .execute(trx);
    }

    const grantOf = grantFor;
    let audits = 0;
    for (let d = 0; d < WORKING_DAYS; d += 10) {
      const rows = [];
      for (let n = 0; n < 300 && audits < 30_000; n++) {
        const actor = pick([supervisor, engineer, pm]);
        const g = grantOf(actor.id);
        rows.push({
          org_id: org.id, project_id: project.id,
          entity_type: pick(['progress_entry', 'issue', 'daily_report']),
          entity_id: pick(locations).id,
          action: pick(['create', 'update', 'verify', 'transition']) as 'create',
          actor_user_id: actor.id,
          actor_grant_id: g?.id ?? null,
          responsibility_label: g?.responsibility_label ?? null,
          occurred_at: new Date(Date.now() - (d + 1) * 86_400_000 + n * 1000),
          source: 'api' as const,
          changes: JSON.stringify([{ field: 'state_class', old: 'draft', new: 'submitted' }]),
        });
        audits += 1;
      }
      if (rows.length) await trx.insertInto('app.audit_log').values(rows).execute();
    }
    console.log(`  ✔ audit rows     ${audits}`);
  });

  console.log(`\n  Done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  await app.close();
}

main().catch((e) => {
  console.error('\n  ✘ Bulk seed failed:', (e as Error).message, '\n');
  process.exit(1);
});
