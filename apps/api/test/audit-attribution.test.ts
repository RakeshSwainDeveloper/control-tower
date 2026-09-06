/**
 * FR-030: the audit trail says in WHAT CAPACITY somebody acted.
 *
 * "Ramesh approved this as Project Manager" is one of the product's stated
 * differentiators, and both columns existed from Phase 2. Until Phase 7 they
 * were empty: 0 of 40 rows carried a grant and 9 carried a label, those nine
 * being the handful of call sites where somebody passed it by hand.
 *
 * The cause was two contexts. `withTenant` declares `app.current_grant_id` to
 * Postgres; `audit.write` read `ctx?.grantId` from the async-local request
 * context, which nothing populated. 104 withTenant call sites could each have
 * passed it — 89 did not, which is what a rule enforced by memory looks like.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('audit attribution', () => {
  it('the permission guard records the grant that satisfied the request', () => {
    const guard = read('modules/access/permission.guard.ts');
    // The guard already resolves the exact grant for the key it checks. It is
    // the only place that covers every route.
    expect(guard).toMatch(/enrichContext\(/);
    expect(guard).toMatch(/grantId: scope\.grantId/);
    expect(guard).toMatch(/responsibilityLabel: scope\.responsibilityLabel/);
  });

  it('audit.write falls back to what the TRANSACTION declared', () => {
    const audit = read('common/audit.service.ts');
    // Not a parallel context that has to be kept in step — the value Postgres
    // itself was given, which cannot drift from what RLS and triggers see.
    expect(audit).toMatch(/current_setting\('app\.current_grant_id', true\)/);
  });

  it('the responsibility label is SNAPSHOTTED, not joined at read time', () => {
    const audit = read('common/audit.service.ts');
    // A company that renames "Site Supervisor" next year must not silently
    // rewrite what last year's approvals say.
    expect(audit).toMatch(/selectFrom\('app\.role_grants'\)/);
    expect(audit).toMatch(/responsibility_label: label/);
  });

  it('the audit log is append-only for the application role', () => {
    // Restated here because attribution is worthless if the row can be edited.
    const migrations = new URL('../../../packages/db/migrations', import.meta.url).pathname;
    const m = readdirSync(migrations).find((f) => f.includes('audit'))!;
    const sql = readFileSync(join(migrations, m), 'utf8');
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON app\.audit_log/);
  });
});
