import {
  Injectable, Inject, BadRequestException, ConflictException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { SodService } from '../access/sod.service.js';
import { ApprovalEngine } from '../approval/approval.engine.js';
import { assertVisible } from '../access/scoped-query.js';
import type { CompiledPermissions } from '../access/permission.service.js';

export interface IssueActor {
  userId: string;
  orgId: string;
  permissions: CompiledPermissions;
}

/** Above this, closing an issue needs approval as well as verification. */
const APPROVAL_SEVERITIES = new Set(['high', 'critical']);

@Injectable()
export class IssuesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly sod: SodService,
    private readonly approval: ApprovalEngine,
  ) {}

  /**
   * Raise an issue.
   *
   * Target: 45 seconds on a phone (FR-458). Category, severity, location, photo,
   * assignee — everything else optional. A form that asks for more than that at
   * the moment someone notices a problem is a form that produces no issues.
   */
  async raise(actor: IssueActor, projectId: string, input: {
    title: string; categoryCode?: string; severity: string;
    description?: string; locationId?: string; workItemId?: string;
    contractorLabel?: string; assigneeUserId?: string; dueDate?: string;
    clientUuid?: string;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.create', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['issue.issue.create'];
    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      (trx) => this.raiseInTrx(trx, actor, projectId, input, grant?.grantId, grant?.responsibilityLabel),
    );
  }

  /** Shared with the sync handler so offline and online produce the same row. */
  async raiseInTrx(
    trx: Transaction<DB>, actor: IssueActor, projectId: string,
    input: {
      title: string; categoryCode?: string; severity: string;
      description?: string; locationId?: string; workItemId?: string;
      contractorLabel?: string; assigneeUserId?: string; dueDate?: string;
      clientUuid?: string;
    },
    grantId?: string, responsibility?: string,
  ) {
    let categoryId: string | null = null;
    if (input.categoryCode) {
      const c = await trx.selectFrom('app.master_data').select('id')
        .where('kind', '=', 'issue_category').where('code', '=', input.categoryCode)
        .executeTakeFirst();
      if (!c) throw new BadRequestException(`Unknown issue category '${input.categoryCode}'`);
      categoryId = c.id;
    }

    const number = (await sql<{ n: string }>`
      SELECT app.next_document_number('issue',
        (SELECT code FROM app.projects WHERE id = ${projectId})) AS n
    `.execute(trx)).rows[0]!.n;

    const row = await trx.insertInto('app.issues').values({
      org_id: actor.orgId, project_id: projectId, issue_number: number,
      category_id: categoryId,
      severity: input.severity as 'medium',
      title: input.title,
      description: input.description ?? null,
      location_id: input.locationId ?? null,
      work_item_id: input.workItemId ?? null,
      contractor_label: input.contractorLabel ?? null,
      assignee_user_id: input.assigneeUserId ?? null,
      due_date: input.dueDate ?? null,
      state_class: input.assigneeUserId ? 'in_progress' : 'draft',
      raised_by: actor.userId,
      raised_by_grant_id: grantId ?? null,
      raised_responsibility: responsibility ?? null,
      client_uuid: input.clientUuid ?? null,
      is_offline_origin: !!input.clientUuid,
    }).returningAll().executeTakeFirstOrThrow();

    await this.audit.write(trx, actor.orgId, {
      entityType: 'issue', entityId: row.id, action: 'create', projectId,
      changes: this.audit.diff(null, {
        issue_number: number, title: row.title, severity: row.severity,
        assignee_user_id: row.assignee_user_id,
      }),
    });
    return row;
  }

  async assign(actor: IssueActor, projectId: string, issueId: string, assigneeUserId: string, dueDate?: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.assign', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.issues').selectAll()
          .where('id', '=', issueId).where('project_id', '=', projectId).executeTakeFirst(),
        'Issue',
      );
      const after = await trx.updateTable('app.issues').set({
        assignee_user_id: assigneeUserId,
        due_date: dueDate ?? before.due_date,
        state_class: before.state_class === 'draft' ? 'in_progress' : before.state_class,
      }).where('id', '=', issueId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'issue', entityId: issueId, action: 'update', projectId,
        changes: this.audit.diff(before, after),
      });
      return after;
    });
  }

  /** Resolve. Closure evidence is required by policy at the API layer. */
  async resolve(actor: IssueActor, projectId: string, issueId: string, note: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.resolve', projectId)) {
      assertVisible(null, 'Project');
    }
    if (note.trim().length < 3) {
      throw new BadRequestException('Say what was done to resolve it');
    }
    const grant = actor.permissions.keys['issue.issue.resolve'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const before = assertVisible(
          await trx.selectFrom('app.issues').selectAll()
            .where('id', '=', issueId).where('project_id', '=', projectId).executeTakeFirst(),
          'Issue',
        );
        if (before.state_class === 'closed') {
          throw new ConflictException('That issue is already closed');
        }

        // FR-446: closure evidence. An issue resolved with no photograph is a
        // claim, and the whole point of the product is that claims carry proof.
        const evidence = await trx.selectFrom('app.evidence_links')
          .select('id').where('entity_type', '=', 'issue').where('entity_id', '=', issueId)
          .where('purpose', 'in', ['closure', 'after', 'issue'])
          .where('unlinked_at', 'is', null).executeTakeFirst();
        if (!evidence) {
          throw new BadRequestException(
            'Attach a photo of the completed work before resolving this issue.',
          );
        }

        const after = await trx.updateTable('app.issues').set({
          state_class: 'resolved',
          resolved_by: actor.userId,
          resolved_by_grant_id: grant?.grantId ?? null,
          resolved_responsibility: grant?.responsibilityLabel ?? null,
          resolved_at: new Date(),
          resolution_note: note,
        }).where('id', '=', issueId).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: 'issue', entityId: issueId, action: 'transition', projectId,
          changes: [{ field: 'state_class', old: before.state_class, new: 'resolved' }],
          context: { resolution_note: note },
        });
        return after;
      },
    );
  }

  /**
   * Verify — by someone who did NOT do the work.
   *
   * SoD-03. On a small site one person often resolves and would happily sign
   * their own work off, which is exactly why the refusal is about the act.
   */
  async verify(actor: IssueActor, projectId: string, issueId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.verify', projectId)) {
      assertVisible(null, 'Project');
    }
    const grant = actor.permissions.keys['issue.issue.verify'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const issue = assertVisible(
          await trx.selectFrom('app.issues').selectAll()
            .where('id', '=', issueId).where('project_id', '=', projectId).executeTakeFirst(),
          'Issue',
        );
        if (issue.state_class !== 'resolved') {
          throw new ConflictException(
            `That issue is ${issue.state_class}, not resolved. There is nothing to verify yet.`,
          );
        }

        // SoD-03 — never verify work you performed yourself.
        this.sod.assertCanVerifyIssue({ userId: actor.userId }, { resolvedBy: issue.resolved_by });

        const after = await trx.updateTable('app.issues').set({
          state_class: 'verified',
          verified_by: actor.userId,
          verified_by_grant_id: grant?.grantId ?? null,
          verified_responsibility: grant?.responsibilityLabel ?? null,
          verified_at: new Date(),
        }).where('id', '=', issueId).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: 'issue', entityId: issueId, action: 'verify', projectId,
          changes: [{ field: 'state_class', old: 'resolved', new: 'verified' }],
        });

        // A high or critical issue needs a decision as well as a check: the
        // engine takes it from here (BR-21 — only the engine approves).
        if (APPROVAL_SEVERITIES.has(issue.severity)) {
          const instance = await this.approval.submitInTrx(
            trx,
            {
              userId: actor.userId, orgId: actor.orgId,
              grantId: grant?.grantId, responsibility: grant?.responsibilityLabel,
            },
            {
              objectType: 'issue_closure', objectId: issueId, projectId,
              // SoD-01 is evaluated against the RESOLVER: the person who did
              // the work must not be the one who approves closing it.
              createdBy: issue.resolved_by ?? issue.raised_by,
              context: { severity: issue.severity, issue_number: issue.issue_number },
            },
          );
          return { ...after, approval_required: true, approval_instance_id: instance.id };
        }
        return { ...after, approval_required: false };
      },
    );
  }

  async close(actor: IssueActor, projectId: string, issueId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.close', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const issue = assertVisible(
        await trx.selectFrom('app.issues').selectAll()
          .where('id', '=', issueId).where('project_id', '=', projectId).executeTakeFirst(),
        'Issue',
      );
      if (issue.state_class !== 'verified') {
        throw new ConflictException(
          `That issue is ${issue.state_class}. It must be verified by someone other ` +
            'than whoever resolved it before it can close.',
        );
      }

      if (APPROVAL_SEVERITIES.has(issue.severity)) {
        const inst = await trx.selectFrom('app.approval_instances')
          .select(['status']).where('object_type', '=', 'issue_closure')
          .where('object_id', '=', issueId)
          .orderBy('submitted_at', 'desc').executeTakeFirst();
        if (inst?.status !== 'approved') {
          throw new ConflictException(
            `A ${issue.severity} issue needs approved closure. Current approval ` +
              `status: ${inst?.status ?? 'not submitted'}.`,
          );
        }
      }

      // The open-query guard is a database trigger, so it holds here and on
      // every future path that closes something.
      const after = await trx.updateTable('app.issues')
        .set({ state_class: 'closed', closed_at: new Date() })
        .where('id', '=', issueId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'issue', entityId: issueId, action: 'transition', projectId,
        changes: [{ field: 'state_class', old: 'verified', new: 'closed' }],
      });
      return after;
    });
  }

  /** FR-452: reopening starts a new cycle; the full history is retained. */
  async reopen(actor: IssueActor, projectId: string, issueId: string, reason: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.reopen', projectId)) {
      assertVisible(null, 'Project');
    }
    if (reason.trim().length < 3) {
      throw new BadRequestException('Say why it is being reopened');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.issues').selectAll()
          .where('id', '=', issueId).where('project_id', '=', projectId).executeTakeFirst(),
        'Issue',
      );
      const after = await trx.updateTable('app.issues').set({
        state_class: 'in_progress',
        // The previous cycle's resolution and verification are cleared from the
        // WORKING fields but remain in the audit trail — the count is what makes
        // a repeatedly-reopened issue visible.
        resolved_by: null, resolved_at: null, resolution_note: null,
        verified_by: null, verified_at: null, closed_at: null,
        reopen_count: before.reopen_count + 1,
        last_reopen_reason: reason,
      }).where('id', '=', issueId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'issue', entityId: issueId, action: 'transition', projectId,
        changes: [{ field: 'state_class', old: before.state_class, new: 'in_progress' }],
        context: { reason, reopen_count: after.reopen_count },
      });
      return after;
    });
  }

  async list(actor: IssueActor, projectId: string, opts: {
    cursor?: string; limit: number; state?: string; severity?: string;
    assigneeUserId?: string; overdue?: boolean; locationId?: string;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx.selectFrom('app.issues as i')
        .leftJoin('app.master_data as c', 'c.id', 'i.category_id')
        .leftJoin('app.users as a', 'a.id', 'i.assignee_user_id')
        .leftJoin('app.location_paths as lp', 'lp.location_id', 'i.location_id')
        .select(['i.id', 'i.issue_number', 'i.title', 'i.severity', 'i.state_class',
                 'i.due_date', 'i.raised_at', 'i.raised_responsibility',
                 'i.resolved_at', 'i.verified_at', 'i.closed_at', 'i.reopen_count',
                 'c.name as category', 'a.name as assignee', 'lp.display_path as location'])
        .where('i.project_id', '=', projectId)
        .orderBy('i.id', 'desc').limit(opts.limit + 1);

      if (opts.state) qb = qb.where('i.state_class', '=', opts.state as 'draft');
      if (opts.severity) qb = qb.where('i.severity', '=', opts.severity as 'low');
      if (opts.assigneeUserId) qb = qb.where('i.assignee_user_id', '=', opts.assigneeUserId);
      if (opts.locationId) qb = qb.where('i.location_id', '=', opts.locationId);
      if (opts.overdue) {
        qb = qb.where('i.due_date', '<', new Date().toISOString().slice(0, 10))
               .where('i.state_class', 'not in', ['closed', 'cancelled']);
      }
      if (opts.cursor) qb = qb.where('i.id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return { data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore };
    });
  }

  /** FR-453: ageing, which is what makes a neglected issue visible. */
  async ageing(actor: IssueActor, projectId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'issue.issue.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const r = await sql<{
        severity: string; open: string; overdue: string;
        median_age_days: string; max_age_days: string;
      }>`
        SELECT severity,
               count(*)                                                        AS open,
               count(*) FILTER (WHERE due_date < current_date)                  AS overdue,
               COALESCE(percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY extract(epoch FROM now() - raised_at)/86400), 0)      AS median_age_days,
               COALESCE(max(extract(epoch FROM now() - raised_at)/86400), 0)    AS max_age_days
        FROM app.issues
        WHERE project_id = ${projectId} AND state_class NOT IN ('closed','cancelled')
        GROUP BY severity ORDER BY severity
      `.execute(trx);

      return {
        metric: 'issue_ageing',
        as_of: new Date().toISOString(),
        definition: 'Open issues by severity, with overdue count and age in days ' +
                    'since they were raised.',
        by_severity: r.rows.map((x) => ({
          severity: x.severity,
          open: Number(x.open),
          overdue: Number(x.overdue),
          median_age_days: Number(Number(x.median_age_days).toFixed(1)),
          max_age_days: Number(Number(x.max_age_days).toFixed(1)),
        })),
        drill: { endpoint: `/api/v1/projects/${projectId}/issues`, params: { overdue: true } },
      };
    });
  }
}
