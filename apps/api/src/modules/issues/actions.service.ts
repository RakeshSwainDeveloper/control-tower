import {
  Injectable, Inject, BadRequestException, ConflictException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { IssueActor } from './issues.service.js';

/**
 * Priority is stored as 1..4, ascending = less urgent, not as a word.
 *
 * Sorting an inbox is the only thing priority is for, and a text column sorts
 * 'high' above 'normal' above 'low' — alphabetically, which is wrong twice.
 * 2 is 'normal' because that is the column's default: an action created with
 * no opinion about priority and one created explicitly as normal must land on
 * the same number, or the inbox sorts them apart for no reason. The CHECK
 * allows a 4th band nobody has asked for yet.
 */
const PRIORITY: Record<string, number> = { high: 1, normal: 2, low: 3 };

/**
 * Actions — one table behind three words site teams already use.
 *
 * PRODUCT_REVIEW C-4: "task", "query" (RFI) and "instruction" were three
 * modules in the reference FRD. They have identical mechanics — someone is
 * asked to do or answer something by a date, and it is open until they do.
 * The only real difference is the word on the screen and whether an answer is
 * required, so they are one entity with a `subtype`. Three tables would have
 * meant three inboxes, and a supervisor with three inboxes checks none.
 */
@Injectable()
export class ActionsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  async create(actor: IssueActor, projectId: string, input: {
    subtype: 'task' | 'query' | 'instruction';
    title: string; description?: string;
    relatedEntityType?: string; relatedEntityId?: string;
    assigneeUserId?: string; assigneeRoleCode?: string;
    dueDate?: string; priority?: string; requiresAcknowledgement?: boolean;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'action.action.create', projectId)) {
      assertVisible(null, 'Project');
    }
    if (!input.assigneeUserId && !input.assigneeRoleCode) {
      // FR-207: an action addressed to nobody is a note, and notes do not get
      // chased. Refuse it at creation rather than let it rot in a list.
      throw new BadRequestException(
        'Assign this to a person or to a role queue — an action with no owner is never done.',
      );
    }
    const grant = actor.permissions.keys['action.action.create'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const row = await trx.insertInto('app.actions').values({
          org_id: actor.orgId, project_id: projectId,
          subtype: input.subtype as 'task',
          title: input.title,
          description: input.description ?? null,
          related_entity_type: input.relatedEntityType ?? null,
          related_entity_id: input.relatedEntityId ?? null,
          assignee_user_id: input.assigneeUserId ?? null,
          assignee_role_code: input.assigneeRoleCode ?? null,
          due_date: input.dueDate ?? null,
          priority: PRIORITY[input.priority ?? 'normal'] ?? PRIORITY['normal']!,
          // An instruction that must be acknowledged defaults to requiring it;
          // that is the only behavioural difference between the subtypes.
          requires_acknowledgement:
            input.requiresAcknowledgement ?? input.subtype === 'instruction',
          state_class: 'in_progress',
          created_by: actor.userId,
          created_by_grant_id: grant?.grantId ?? null,
          created_responsibility: grant?.responsibilityLabel ?? null,
        }).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: 'action', entityId: row.id, action: 'create', projectId,
          changes: this.audit.diff(null, {
            subtype: row.subtype, title: row.title,
            assignee_user_id: row.assignee_user_id,
            assignee_role_code: row.assignee_role_code, due_date: row.due_date,
          }),
        });
        return row;
      },
    );
  }

  /**
   * Accept a role-queue action.
   *
   * FR-209: work addressed to "any Site Engineer" belongs to nobody until one
   * of them takes it. Acceptance is a race resolved in the database, so two
   * engineers tapping at once cannot both own it.
   */
  async accept(actor: IssueActor, projectId: string, actionId: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const action = assertVisible(
        await trx.selectFrom('app.actions').selectAll()
          .where('id', '=', actionId).where('project_id', '=', projectId).executeTakeFirst(),
        'Action',
      );
      if (action.accepted_by) {
        throw new ConflictException(
          action.accepted_by === actor.userId
            ? 'You already accepted this.'
            : 'Somebody else has already accepted this one.',
        );
      }
      const claimed = await trx.updateTable('app.actions')
        .set({ accepted_by: actor.userId, accepted_at: new Date(), assignee_user_id: actor.userId })
        .where('id', '=', actionId)
        .where('accepted_by', 'is', null)   // ← the race is decided here
        .returningAll().executeTakeFirst();
      if (!claimed) throw new ConflictException('Somebody else has already accepted this one.');

      await this.audit.write(trx, actor.orgId, {
        entityType: 'action', entityId: actionId, action: 'update', projectId,
        changes: [{ field: 'accepted_by', old: null, new: actor.userId }],
      });
      return claimed;
    });
  }

  async acknowledge(actor: IssueActor, projectId: string, actionId: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const action = assertVisible(
        await trx.selectFrom('app.actions').selectAll()
          .where('id', '=', actionId).where('project_id', '=', projectId).executeTakeFirst(),
        'Action',
      );
      if (action.assignee_user_id !== actor.userId) {
        throw new BadRequestException('Only the person it is addressed to can acknowledge it.');
      }
      const after = await trx.updateTable('app.actions')
        .set({ acknowledged_by: actor.userId, acknowledged_at: new Date() })
        .where('id', '=', actionId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'action', entityId: actionId, action: 'update', projectId,
        changes: [{ field: 'acknowledged_at', old: null, new: after.acknowledged_at }],
      });
      return after;
    });
  }

  async complete(actor: IssueActor, projectId: string, actionId: string, note?: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const action = assertVisible(
        await trx.selectFrom('app.actions').selectAll()
          .where('id', '=', actionId).where('project_id', '=', projectId).executeTakeFirst(),
        'Action',
      );
      if (action.state_class === 'closed') {
        throw new ConflictException('That action is already complete.');
      }
      if (action.requires_acknowledgement && !action.acknowledged_at) {
        throw new ConflictException(
          'Acknowledge this instruction before marking it complete.',
        );
      }
      // A query is complete when it has been ANSWERED, not when the person who
      // asked decides to tidy their list (FR-211).
      if (action.subtype === 'query') {
        const unanswered = await trx.selectFrom('app.comments')
          .select('id').where('entity_type', '=', 'action').where('entity_id', '=', actionId)
          .where('is_query', '=', true).where('answered_at', 'is', null)
          .executeTakeFirst();
        if (unanswered) {
          throw new ConflictException('This query has not been answered yet.');
        }
      }

      const after = await trx.updateTable('app.actions').set({
        state_class: 'closed', completed_at: new Date(), completion_note: note ?? null,
      }).where('id', '=', actionId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'action', entityId: actionId, action: 'transition', projectId,
        changes: [{ field: 'state_class', old: action.state_class, new: 'closed' }],
        context: note ? { completion_note: note } : undefined,
      });
      return after;
    });
  }

  async cancel(actor: IssueActor, projectId: string, actionId: string, reason: string) {
    if (reason.trim().length < 3) throw new BadRequestException('Say why it is being cancelled');
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const action = assertVisible(
        await trx.selectFrom('app.actions').selectAll()
          .where('id', '=', actionId).where('project_id', '=', projectId).executeTakeFirst(),
        'Action',
      );
      const after = await trx.updateTable('app.actions').set({
        state_class: 'cancelled', cancelled_at: new Date(), cancel_reason: reason,
      }).where('id', '=', actionId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'action', entityId: actionId, action: 'transition', projectId,
        changes: [{ field: 'state_class', old: action.state_class, new: 'cancelled' }],
        context: { reason },
      });
      return after;
    });
  }

  /**
   * Comment, or raise a query against any record.
   *
   * FR-213: a query blocks closure of whatever it hangs on, via the database
   * trigger `app.block_close_with_open_query()`. That is deliberate — the
   * question is the point, and a record closed over an unanswered question
   * makes the answer worthless.
   */
  async comment(actor: IssueActor, projectId: string, input: {
    entityType: string; entityId: string; body: string;
    isQuery?: boolean; addressedToUserId?: string;
  }) {
    if (input.body.trim().length === 0) throw new BadRequestException('Empty comment');
    if (input.isQuery && !input.addressedToUserId) {
      throw new BadRequestException('A query has to be addressed to somebody.');
    }
    const grant = actor.permissions.keys['action.action.create'];

    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: grant?.grantId },
      async (trx) => {
        const row = await trx.insertInto('app.comments').values({
          org_id: actor.orgId, project_id: projectId,
          entity_type: input.entityType as 'issue', entity_id: input.entityId,
          body: input.body, is_query: !!input.isQuery,
          addressed_to_user_id: input.addressedToUserId ?? null,
          author_id: actor.userId,
          author_grant_id: grant?.grantId ?? null,
          author_responsibility: grant?.responsibilityLabel ?? null,
        }).returningAll().executeTakeFirstOrThrow();

        await this.audit.write(trx, actor.orgId, {
          entityType: input.entityType, entityId: input.entityId,
          action: 'comment', projectId,
          context: { comment_id: row.id, is_query: row.is_query },
        });
        return row;
      },
    );
  }

  async answerQuery(actor: IssueActor, projectId: string, commentId: string, answer: string) {
    if (answer.trim().length === 0) throw new BadRequestException('Empty answer');
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const q = assertVisible(
        await trx.selectFrom('app.comments').selectAll()
          .where('id', '=', commentId).where('project_id', '=', projectId)
          .where('is_query', '=', true).executeTakeFirst(),
        'Query',
      );
      if (q.answered_at) throw new ConflictException('That query is already answered.');

      const after = await trx.updateTable('app.comments').set({
        answered_by: actor.userId, answered_at: new Date(), answer_body: answer,
      }).where('id', '=', commentId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: q.entity_type, entityId: q.entity_id, action: 'comment', projectId,
        context: { answered_query_id: commentId },
      });
      return after;
    });
  }

  async thread(actor: IssueActor, projectId: string, entityType: string, entityId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, (trx) =>
      trx.selectFrom('app.comments as c')
        .leftJoin('app.users as u', 'u.id', 'c.author_id')
        .leftJoin('app.users as t', 't.id', 'c.addressed_to_user_id')
        .leftJoin('app.users as a', 'a.id', 'c.answered_by')
        .select(['c.id', 'c.body', 'c.is_query', 'c.created_at',
                 'c.answer_body', 'c.answered_at', 'c.author_responsibility',
                 'u.name as author', 't.name as addressed_to', 'a.name as answered_by_name'])
        .where('c.project_id', '=', projectId)
        .where('c.entity_type', '=', entityType as 'issue')
        .where('c.entity_id', '=', entityId)
        .orderBy('c.created_at', 'asc').execute());
  }

  /**
   * "My Work" — FR-199 / FR-458.
   *
   * One list, not four. Everything waiting on this person: approval tasks,
   * actions assigned to them, unanswered queries addressed to them, and role
   * queue items nobody has accepted. Sorted by what is late, not by table.
   */
  async myWork(actor: IssueActor, opts: { projectId?: string; limit: number }) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const roleCodes = (await trx.selectFrom('app.role_grants as rg')
        .innerJoin('app.roles as r', 'r.id', 'rg.role_id')
        .select('r.code').where('rg.user_id', '=', actor.userId)
        .where('rg.revoked_at', 'is', null).execute()).map((x) => x.code);

      const rows = await sql<{
        kind: string; id: string; project_id: string; title: string;
        due_date: string | null; created_at: Date; needs_acceptance: boolean;
      }>`
        SELECT * FROM (
          SELECT 'approval'::text AS kind, t.id, i.project_id,
                 'Approve ' || i.object_type || ' ' ||
                   COALESCE(i.context->>'label', i.context->>'issue_number', '') AS title,
                 t.sla_due_at::date AS due_date, t.assigned_at AS created_at,
                 false AS needs_acceptance
            FROM app.approval_tasks t
            JOIN app.approval_instances i ON i.id = t.instance_id
           WHERE t.assignee_user_id = ${actor.userId} AND t.status = 'pending'
             AND (${opts.projectId ?? null}::uuid IS NULL OR i.project_id = ${opts.projectId ?? null}::uuid)

          UNION ALL
          SELECT a.subtype::text, a.id, a.project_id, a.title, a.due_date, a.created_at, false
            FROM app.actions a
           WHERE a.assignee_user_id = ${actor.userId}
             AND a.state_class NOT IN ('closed','cancelled')
             AND (${opts.projectId ?? null}::uuid IS NULL OR a.project_id = ${opts.projectId ?? null}::uuid)

          UNION ALL
          SELECT 'queue_' || a.subtype::text, a.id, a.project_id, a.title, a.due_date, a.created_at, true
            FROM app.actions a
           WHERE a.assignee_user_id IS NULL AND a.accepted_by IS NULL
             AND a.assignee_role_code = ANY(${roleCodes}::text[])
             AND a.state_class NOT IN ('closed','cancelled')
             AND (${opts.projectId ?? null}::uuid IS NULL OR a.project_id = ${opts.projectId ?? null}::uuid)

          UNION ALL
          SELECT 'query', c.id, c.project_id, c.body, NULL::date, c.created_at, false
            FROM app.comments c
           WHERE c.is_query AND c.answered_at IS NULL
             AND c.addressed_to_user_id = ${actor.userId}
             AND (${opts.projectId ?? null}::uuid IS NULL OR c.project_id = ${opts.projectId ?? null}::uuid)

          UNION ALL
          SELECT 'issue', s.id, s.project_id, s.title, s.due_date, s.raised_at, false
            FROM app.issues s
           WHERE s.assignee_user_id = ${actor.userId}
             AND s.state_class NOT IN ('closed','cancelled','verified')
             AND (${opts.projectId ?? null}::uuid IS NULL OR s.project_id = ${opts.projectId ?? null}::uuid)
        ) AS w
        -- Overdue first, then oldest. Nothing here is sorted by entity type,
        -- because the person reading it does not think in entity types.
        --
        -- The UNION is wrapped: PostgreSQL only lets ORDER BY after a set
        -- operation reference output column NAMES, not expressions over them.
        ORDER BY (w.due_date IS NOT NULL AND w.due_date < current_date) DESC,
                 w.due_date ASC NULLS LAST, w.created_at ASC
        LIMIT ${opts.limit}
      `.execute(trx);

      const today = new Date().toISOString().slice(0, 10);
      return rows.rows.map((r) => ({
        ...r,
        overdue: !!r.due_date && r.due_date < today,
      }));
    });
  }
}
