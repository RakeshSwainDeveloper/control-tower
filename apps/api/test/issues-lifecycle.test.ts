/**
 * The issue lifecycle, driven through the real service against real rows.
 *
 * raise → assign → resolve (with evidence) → verify (by someone else) → close,
 * plus reopen. The properties worth protecting are the ones a site would
 * otherwise route around:
 *
 *   · An issue cannot be resolved on a promise. There must be a photograph.
 *   · An issue cannot be signed off by whoever fixed it (SoD-03).
 *   · An unanswered query blocks closure — enforced by a database trigger, so
 *     it also holds for code written after this test.
 *   · Reopening keeps the count. A defect fixed three times is a different
 *     conversation from a defect fixed once.
 *
 * The SoD-03 test deliberately uses a user holding BOTH issue.issue.resolve and
 * issue.issue.verify. Phase 5 taught this the hard way: a supervisor without
 * the verify permission is stopped by the permission guard, so the test proves
 * the guard works and says nothing at all about separation of duty.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withTenant, withoutTenant, type DB } from '@ct/db';
import { appDb, migratorDb } from './helpers.js';
import { IssuesService, type IssueActor } from '../src/modules/issues/issues.service.js';
import { ActionsService } from '../src/modules/issues/actions.service.js';
import { ApprovalEngine } from '../src/modules/approval/approval.engine.js';
import { PermissionService } from '../src/modules/access/permission.service.js';
import { SodService } from '../src/modules/access/sod.service.js';
import { AuditService } from '../src/common/audit.service.js';

const noopLogger = {
  warn: () => undefined, error: () => undefined,
  info: () => undefined, debug: () => undefined,
} as never;

describe('issue lifecycle', () => {
  let db: Kysely<DB>;
  let owner: Kysely<DB>;
  let issues: IssuesService;
  let actions: ActionsService;
  let perms: PermissionService;

  let orgId: string;
  let projectId: string;
  let evidenceId: string;
  /** Holds resolve AND verify — the only actor that can prove SoD-03. */
  let vijay: IssueActor;
  /** Holds resolve and verify too, so it can verify Vijay's work legitimately. */
  let anita: IssueActor;

  beforeAll(async () => {
    db = appDb();
    owner = migratorDb();

    const org = await withoutTenant(owner, 'fixture precedes tenant context', (trx) =>
      trx.insertInto('app.organizations').values({
        legal_name: 'Lifecycle Ltd', display_name: 'Lifecycle',
        slug: `life-${Date.now().toString(36)}`,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    orgId = org.id;

    const ids = await withTenant(owner, { orgId }, async (trx) => {
      const company = await trx.insertInto('app.companies')
        .values({ org_id: orgId, name: 'Lifecycle', is_default: true })
        .returning('id').executeTakeFirstOrThrow();

      // A role that can do the whole cycle. Realistic on a small site, and the
      // only configuration under which SoD-03 has anything to prove.
      const role = await trx.insertInto('app.roles').values({
        org_id: orgId, code: 'site_engineer_full', name: 'Site Engineer (full cycle)',
        is_system: false, applicable_scope_levels: ['project'],
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('app.role_permissions').values(
        ['issue.issue.create', 'issue.issue.read', 'issue.issue.assign',
         'issue.issue.resolve', 'issue.issue.verify', 'issue.issue.close',
         'issue.issue.reopen', 'action.action.create', 'action.action.read',
        ].map((key) => ({
          org_id: orgId, role_id: role.id, permission_key: key,
          record_qualifier: 'all_in_scope' as const,
        })),
      ).execute();

      // Real provisioning seeds this (provisioning.service.ts). Raising an
      // issue is not allowed to invent a number when no series is configured —
      // ISS-LIFE-0001 must mean the same thing to everyone on the site.
      await trx.insertInto('app.numbering_series').values({
        org_id: orgId, entity_type: 'issue', prefix: 'ISS', include_project_code: true,
      }).execute();

      const users: string[] = [];
      for (const name of ['Vijay', 'Anita']) {
        const u = await trx.insertInto('app.users').values({
          org_id: orgId, name, email: `${name.toLowerCase()}-${Date.now()}@x.test`,
          status: 'active',
        }).returning('id').executeTakeFirstOrThrow();
        users.push(u.id);
      }

      const project = await trx.insertInto('app.projects').values({
        org_id: orgId, company_id: company.id, code: 'LIFE', name: 'Lifecycle Site',
        accountable_manager_user_id: users[0]!, commercial_owner_user_id: users[0]!,
      }).returning('id').executeTakeFirstOrThrow();

      for (const uid of users) {
        await trx.insertInto('app.role_grants').values({
          org_id: orgId, user_id: uid, role_id: role.id,
          scope_type: 'project', scope_id: project.id,
          responsibility_label: 'Site Engineer', granted_by: uid,
        }).execute();
      }

      // One evidence asset, reused as the closure photo. It carries GPS
      // because Phase 4's evidence_gps_or_reason refuses a site photograph
      // that has neither a location nor a stated reason for lacking one —
      // a rule this fixture is subject to like any other caller.
      const asset = await trx.insertInto('app.evidence_assets').values({
        org_id: orgId, kind: 'photo',
        storage_key: `org/${orgId}/test/closure.jpg`,
        mime_type: 'image/jpeg', size_bytes: 1024,
        content_hash: 'a'.repeat(64),
        gps_lat: '12.9716', gps_lng: '77.5946',
        captured_at_device: new Date(), captured_by: users[0]!,
        capture_method: 'in_app_camera',
        // 'uploaded', not the default 'pending_upload'. Phase 7 tightened the
        // resolve guard to require the ASSET to have landed, not merely a link
        // to exist — an abandoned upload leaves a link pointing at nothing, and
        // a guard that only checked for the link would accept a resolution
        // backed by a photograph that does not exist. This fixture was doing
        // exactly that.
        state: 'uploaded', uploaded_at: new Date(),
      }).returning('id').executeTakeFirstOrThrow();

      return { projectId: project.id, users, evidenceId: asset.id };
    });

    projectId = ids.projectId;
    evidenceId = ids.evidenceId;

    perms = new PermissionService(db);
    const audit = new AuditService();
    const sod = new SodService();
    const engine = new ApprovalEngine(db, noopLogger, audit, sod);
    issues = new IssuesService(db, audit, perms, sod, engine);
    actions = new ActionsService(db, audit, perms);

    vijay = {
      userId: ids.users[0]!, orgId,
      permissions: await perms.compile(orgId, ids.users[0]!),
    };
    anita = {
      userId: ids.users[1]!, orgId,
      permissions: await perms.compile(orgId, ids.users[1]!),
    };
  });

  afterAll(async () => {
    await withTenant(owner, { orgId }, async (trx) => {
      for (const t of ['app.comments', 'app.actions', 'app.evidence_links',
                       'app.issues', 'app.evidence_assets', 'app.role_grants',
                       'app.role_permissions', 'app.projects', 'app.roles',
                       'app.users', 'app.numbering_counters',
                       'app.numbering_series', 'app.companies'] as const) {
        await sql`DELETE FROM ${sql.table(t.slice(4))} WHERE org_id = ${orgId}`.execute(trx);
      }
    });
    await withoutTenant(owner, 'teardown', async (trx) => {
      await trx.deleteFrom('app.organizations').where('id', '=', orgId).execute();
    });
    await db.destroy();
    await owner.destroy();
  });

  /** Attach the closure photo to an issue, the way the evidence module would. */
  const attachEvidence = (issueId: string) =>
    withTenant(owner, { orgId, userId: vijay.userId }, (trx) =>
      trx.insertInto('app.evidence_links').values({
        org_id: orgId, project_id: projectId, evidence_id: evidenceId,
        entity_type: 'issue', entity_id: issueId, purpose: 'closure',
        linked_by: vijay.userId,
      }).execute());

  let issueId: string;

  it('raises an issue with a document number and a named responsibility', async () => {
    const row = await issues.raise(vijay, projectId, {
      title: 'Honeycombing on column C4, second floor',
      severity: 'medium',
      description: 'Visible voids around the base, roughly 300mm up.',
    });
    issueId = row.id;

    expect(row.issue_number, 'issues are numbered for site conversation').toBeTruthy();
    expect(row.state_class).toBe('draft');
    expect(row.raised_by).toBe(vijay.userId);
    // FR-030: not just who, but in what capacity.
    expect(row.raised_responsibility).toBe('Site Engineer');
  });

  it('assigning it moves it into progress', async () => {
    const row = await issues.assign(vijay, projectId, issueId, vijay.userId, '2026-09-30');
    expect(row.state_class).toBe('in_progress');
    expect(row.assignee_user_id).toBe(vijay.userId);
  });

  it('REFUSES to resolve without a photograph', async () => {
    await expect(
      issues.resolve(vijay, projectId, issueId, 'Chipped out and repacked'),
    ).rejects.toThrow(/photo/i);

    const row = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.issues').select('state_class')
        .where('id', '=', issueId).executeTakeFirstOrThrow());
    expect(row.state_class, 'the refusal must not half-apply').toBe('in_progress');
  });

  it('resolves once the evidence is attached', async () => {
    await attachEvidence(issueId);
    const row = await issues.resolve(vijay, projectId, issueId, 'Chipped out and repacked with grout');
    expect(row.state_class).toBe('resolved');
    expect(row.resolved_by).toBe(vijay.userId);
    expect(row.resolution_note).toMatch(/grout/);
  });

  it('SoD-03: the person who resolved it CANNOT verify it — even holding the permission', async () => {
    // Vijay holds issue.issue.verify. The refusal is about the act, not the role.
    expect(
      perms.holdsOnProject(vijay.permissions, 'issue.issue.verify', projectId),
      'the fixture is wrong: this test proves nothing unless Vijay can verify in general',
    ).toBe(true);

    await expect(issues.verify(vijay, projectId, issueId)).rejects.toThrow(/SoD-03/);
  });

  it('a different engineer verifies it', async () => {
    const row = await issues.verify(anita, projectId, issueId);
    expect(row.state_class).toBe('verified');
    expect(row.verified_by).toBe(anita.userId);
    expect(row.verified_responsibility).toBe('Site Engineer');
    // Medium severity: no approval step, so closure is immediate.
    expect(row.approval_required).toBe(false);
  });

  it('an unanswered query BLOCKS closure', async () => {
    await actions.comment(anita, projectId, {
      entityType: 'issue', entityId: issueId,
      body: 'Was the same mix used as on C3?',
      isQuery: true, addressedToUserId: vijay.userId,
    });

    await expect(issues.close(anita, projectId, issueId)).rejects.toThrow();

    const row = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.issues').select('state_class')
        .where('id', '=', issueId).executeTakeFirstOrThrow());
    expect(row.state_class).toBe('verified');
  });

  it('closes once the query is answered', async () => {
    const q = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.comments').select('id')
        .where('entity_id', '=', issueId).where('is_query', '=', true)
        .executeTakeFirstOrThrow());
    await actions.answerQuery(vijay, projectId, q.id, 'Yes, same M30 mix.');

    const row = await issues.close(anita, projectId, issueId);
    expect(row.state_class).toBe('closed');
    expect(row.closed_at).toBeTruthy();
  });

  it('reopening clears the working fields and increments the count', async () => {
    const row = await issues.reopen(anita, projectId, issueId, 'Voids visible again after formwork strike');
    expect(row.state_class).toBe('in_progress');
    expect(row.reopen_count).toBe(1);
    expect(row.resolved_by, 'the new cycle starts unresolved').toBeNull();
    expect(row.verified_by).toBeNull();
    expect(row.last_reopen_reason).toMatch(/formwork/);

    // But the previous cycle is still in the audit trail — that is where the
    // history lives, and it is what makes a repeat defect arguable.
    const trail = await withTenant(db, { orgId }, (trx) =>
      trx.selectFrom('app.audit_log').select(['action'])
        .where('entity_id', '=', issueId).execute());
    expect(trail.length).toBeGreaterThanOrEqual(5);
  });

  it('an action addressed to nobody is refused at creation', async () => {
    await expect(
      actions.create(vijay, projectId, { subtype: 'task', title: 'Tidy the site office' }),
    ).rejects.toThrow(/owner|assign/i);
  });

  it('a role-queue action can only be accepted once', async () => {
    const a = await actions.create(vijay, projectId, {
      subtype: 'task', title: 'Re-check C4 after 7 days',
      assigneeRoleCode: 'site_engineer_full', dueDate: '2026-10-05',
    });
    expect(a.assignee_user_id).toBeNull();

    const claimed = await actions.accept(anita, projectId, a.id);
    expect(claimed.accepted_by).toBe(anita.userId);
    await expect(actions.accept(vijay, projectId, a.id)).rejects.toThrow(/already accepted/i);
  });

  it('My Work returns one list, with the overdue items first', async () => {
    const work = await actions.myWork(anita, { projectId, limit: 50 });
    expect(work.length).toBeGreaterThan(0);
    // Mixed kinds in a single list — that is the point of it.
    expect(work.every((w) => typeof w.kind === 'string')).toBe(true);
    const overdueIdx = work.findIndex((w) => w.overdue);
    const onTimeIdx = work.findIndex((w) => !w.overdue);
    if (overdueIdx !== -1 && onTimeIdx !== -1) {
      expect(overdueIdx, 'late work must sort above work that is not').toBeLessThan(onTimeIdx);
    }
  });
});
