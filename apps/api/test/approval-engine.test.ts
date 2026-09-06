/**
 * The approval engine's four non-negotiables.
 *
 * These are structural guarantees, so they are asserted against the database
 * and the engine source rather than through HTTP. A guarantee that only holds
 * on the paths someone remembered to route through the API is not a guarantee.
 *
 *  BR-20  A published spec is immutable; in-flight instances finish under the
 *         rules they started on.
 *  BR-21  ONLY the engine may set the 'approved' state class.
 *  BR-22  A missing routing rule refuses the submission. It never auto-approves.
 *  SoD-01 Nobody approves their own record — enforced in the engine, so it
 *         holds for every object type that will ever be added.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { withoutTenant, type DB } from '@ct/db';
import { appDb } from './helpers.js';

const ENGINE = readFileSync(
  new URL('../src/modules/approval/approval.engine.ts', import.meta.url), 'utf8',
);

describe('approval engine — structural guarantees', () => {
  let db: Kysely<DB>;
  beforeAll(() => { db = appDb(); });
  afterAll(async () => { await db.destroy(); });

  it('BR-20: an instance snapshots the spec it started under', async () => {
    const col = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ column_name: string; is_nullable: string }>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='app' AND table_name='approval_instances'
          AND column_name='spec_snapshot'
      `.execute(trx);
      return r.rows[0];
    });
    // Nullable would mean "some instances have no snapshot", and those are
    // exactly the ones whose history could later be rewritten.
    expect(col?.column_name).toBe('spec_snapshot');
    expect(col?.is_nullable).toBe('NO');
    expect(ENGINE).toMatch(/spec_snapshot:/);
  });

  it('BR-21: no module outside the engine sets state_class to approved', async () => {
    // A grep across the whole API, not a review of the modules that exist today.
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      "grep -rn \"state_class: 'approved'\" src/ || true",
      { cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8' },
    ).trim();
    /**
     * One exception, named explicitly rather than by loosening the rule.
     *
     * The bulk fixture backdates a year of already-approved reports; routing
     * 300 of them through the engine would be 600 round trips to build a
     * fixture. It is a CLI, not a module serving requests, and it is listed
     * here by exact path so that any OTHER file — including a future one in
     * src/cli/ — still fails this test.
     */
    const ALLOWED = ['src/cli/seed-bulk.ts'];
    const offenders = hits
      ? hits.split('\n').filter((l) =>
          !l.startsWith('src/modules/approval/')
          && !ALLOWED.some((a) => l.startsWith(a)))
      : [];
    expect(offenders, `modules setting 'approved' outside the engine:\n${offenders.join('\n')}`)
      .toEqual([]);
    expect(hits).toContain('src/modules/approval/approval.engine.ts');
  });

  it('BR-22: a missing workflow definition refuses, it does not auto-approve', () => {
    // The failure mode this forbids is silent: no routing configured, so the
    // record sails through unapproved and nobody finds out until an audit.
    expect(ENGINE).toMatch(/No approval workflow is configured/);
    expect(ENGINE).toMatch(/Submission is refused rather than auto-approved/);
    // And the refusal must be a thrown error, not a logged warning.
    const idx = ENGINE.indexOf('No approval workflow is configured');
    expect(ENGINE.slice(Math.max(0, idx - 220), idx)).toMatch(/throw new BadRequestException/);
  });

  it('SoD-01 is applied in the ENGINE, not in each calling module', () => {
    expect(ENGINE).toMatch(/candidates\.filter\(\(c\) => c\.userId !== input\.createdBy\)/);
  });

  it('SoD-04 step collapse is recorded, never silent', async () => {
    // Collapsing two steps into one because the same person holds both roles is
    // legitimate. Doing it without leaving a trace is how a two-signature
    // control quietly becomes a one-signature control.
    const col = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='app' AND table_name='approval_step_instances'
          AND column_name='collapsed_from_step_no'
      `.execute(trx);
      return r.rows[0];
    });
    expect(col?.column_name).toBe('collapsed_from_step_no');
  });

  it('approval_decisions is append-only for the application role', async () => {
    const grants = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ privilege_type: string }>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='app' AND table_name='approval_decisions' AND grantee='ct_app'
        ORDER BY privilege_type
      `.execute(trx);
      return r.rows.map((x) => x.privilege_type);
    });
    // A decision that can be edited is not evidence of anything.
    expect(grants.sort()).toEqual(['INSERT', 'SELECT']);
    expect(grants).not.toContain('UPDATE');
    expect(grants).not.toContain('DELETE');
  });

  it('an object can have at most one live approval instance', async () => {
    const idx = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname='app' AND indexname='approval_instances_one_live'
      `.execute(trx);
      return r.rows[0]?.indexdef ?? '';
    });
    expect(idx).toMatch(/UNIQUE/);
    expect(idx).toMatch(/object_type/);
    expect(idx).toMatch(/object_id/);
    // Partial: completed instances must be allowed to coexist, or a rejected
    // record could never be resubmitted.
    expect(idx).toMatch(/WHERE/);
  });

  it('the MVP carries no money through the approval engine', async () => {
    const def = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='app.approval_instances'::regclass
          AND conname='approval_instances_no_money_in_mvp'
      `.execute(trx);
      return r.rows[0]?.def ?? '';
    });
    expect(def).toMatch(/amount IS NULL/);
    expect(def).toMatch(/currency IS NULL/);
  });

  it('FR-201: a query keeps the clock running instead of pausing it', () => {
    // The tempting design is to stop the SLA while a question is outstanding.
    // That makes "raise a query" the cheapest way to make an overdue item look
    // on time.
    expect(ENGINE).toMatch(/the ageing clock keeps running/);
    const q = ENGINE.slice(ENGINE.indexOf("case 'query':"));
    expect(q.slice(0, 1200)).not.toMatch(/sla_due_at:\s*null/);
  });

  it('BR-21 is WHOLE: the engine writes the outcome back to the object', () => {
    // It updated its own instance row and returned `object_state: 'approved'`
    // without ever writing it. An approved daily report stayed `submitted` for
    // ever, so the trail and the record disagreed permanently — and the trail
    // is what nobody looks at until an audit.
    expect(ENGINE).toMatch(/private async stampObject\(/);
    // Both decision paths, not just the happy one.
    const approvePath = ENGINE.slice(ENGINE.indexOf("instance_status: 'approved'") - 400,
                                     ENGINE.indexOf("instance_status: 'approved'"));
    expect(approvePath, 'approval does not stamp the object').toMatch(/stampObject\(/);
    const rejectIdx = ENGINE.indexOf("outcome = { instance_status: 'rejected'");
    expect(ENGINE.slice(rejectIdx - 300, rejectIdx),
           'rejection does not stamp the object').toMatch(/stampObject\(/);
  });

  it('an object type the engine cannot stamp is LOGGED, never thrown', () => {
    // The decision is real and already recorded by the time we get here.
    // Losing it to a rollback would be worse than a stale flag on the record.
    const fn = ENGINE.slice(ENGINE.indexOf('private async stampObject('));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/this\.log\.warn\(/);
    expect(body).not.toMatch(/throw new/);
  });

  it('an APPROVED issue closure does not close the issue behind issues.close()', () => {
    // The open-query guard and the verified-before-closed rule live there. An
    // engine that closed the issue itself would route around both.
    const fn = ENGINE.slice(ENGINE.indexOf('private async stampObject('));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    const issueBranch = body.slice(body.indexOf("issue_closure"));
    expect(issueBranch).toMatch(/state === 'rejected'/);
    expect(issueBranch).not.toMatch(/state_class: 'closed'/);
  });

  it('the engine, not the caller, decides who the approvers are', () => {
    expect(ENGINE).toMatch(/resolveApprovers/);
    // Sibling tasks must be withdrawn when a decision is taken, or a
    // second approver could decide an instance that has already finished.
    expect(ENGINE).toMatch(/withdrawSiblingTasks/);
  });
});
