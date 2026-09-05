import {
  Injectable, Inject, BadRequestException, ConflictException, ForbiddenException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import { withTenant, type DB } from '@ct/db';
import { SodViolationError } from '@ct/contracts';
import { DB_TOKEN, LOGGER_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { SodService } from '../access/sod.service.js';
import { assertVisible } from '../access/scoped-query.js';

export type ApprovalDecision = 'approve' | 'reject' | 'hold' | 'query';

export interface StepSpec {
  step_no: number;
  name: string;
  resolver: 'role_in_project' | 'project_manager';
  role_code?: string;
  sla_hours?: number;
  is_mandatory?: boolean;
}

export interface SubmitInput {
  objectType: string;
  objectId: string;
  projectId: string;
  /** Who created the object. SoD-01 is evaluated against this, not the submitter. */
  createdBy: string;
  context?: Record<string, unknown>;
}

export interface EngineActor {
  userId: string;
  orgId: string;
  grantId?: string | undefined;
  responsibility?: string | undefined;
}

/**
 * The approval engine.
 *
 * Modules SUBMIT an object and react to the outcome. They do not decide who
 * approves, in what order, or what "approved" means — that is what stops the
 * same rules being reimplemented per module and drifting apart.
 *
 * The MVP engine is sequential with two resolvers and two object types. Its
 * SHAPE is the full one, so Phase 3's money objects arrive as configuration.
 */
@Injectable()
export class ApprovalEngine {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(LOGGER_TOKEN) private readonly log: Logger,
    private readonly audit: AuditService,
    private readonly sod: SodService,
  ) {}

  /**
   * Submits an object for approval.
   *
   * Fails LOUDLY when nothing routes (BR-22). Silent auto-approval on missing
   * configuration is the worst possible failure mode: it produces an approval
   * no human made, on an object nobody looked at, and it is indistinguishable
   * from a real one afterwards.
   */
  async submit(actor: EngineActor, input: SubmitInput) {
    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: actor.grantId },
      (trx) => this.submitInTrx(trx, actor, input),
    );
  }

  async submitInTrx(trx: Transaction<DB>, actor: EngineActor, input: SubmitInput) {
    const live = await trx.selectFrom('app.approval_instances').select(['id', 'status'])
      .where('object_type', '=', input.objectType).where('object_id', '=', input.objectId)
      .where('status', 'in', ['in_progress', 'on_hold', 'query_raised'])
      .executeTakeFirst();
    if (live) {
      throw new ConflictException(
        'That record is already awaiting approval. Two live instances would mean two answers.',
      );
    }

    // Most specific scope wins: a project definition overrides the org default.
    const def = await trx.selectFrom('app.approval_definitions')
      .select(['id', 'name', 'scope_type'])
      .where('object_type', '=', input.objectType)
      .where('is_active', '=', true)
      .where((eb) => eb.or([
        eb.and([eb('scope_type', '=', 'project'), eb('scope_id', '=', input.projectId)]),
        eb('scope_type', '=', 'org'),
      ]))
      .orderBy(sql`CASE WHEN scope_type = 'project' THEN 0 ELSE 1 END`)
      .executeTakeFirst();

    if (!def) {
      throw new BadRequestException(
        `No approval workflow is configured for '${input.objectType}'. ` +
          'Submission is refused rather than auto-approved — an approval no ' +
          'human made is worse than no control at all. Ask your administrator ' +
          'to configure one.',
      );
    }

    const version = assertVisible(
      await trx.selectFrom('app.approval_versions').selectAll()
        .where('definition_id', '=', def.id)
        .orderBy('version_no', 'desc').executeTakeFirst(),
      'Approval version',
    );
    const steps = version.spec as unknown as StepSpec[];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BadRequestException(
        `The approval workflow for '${input.objectType}' has no steps. Submission refused.`,
      );
    }

    const instance = await trx.insertInto('app.approval_instances').values({
      org_id: actor.orgId,
      project_id: input.projectId,
      object_type: input.objectType,
      object_id: input.objectId,
      definition_id: def.id,
      version_id: version.id,
      // BR-20: the snapshot. The instance completes under the version it
      // started on, whatever the definition says later.
      spec_snapshot: JSON.stringify(steps),
      context: JSON.stringify({ ...(input.context ?? {}), created_by: input.createdBy }),
      status: 'in_progress',
      state_class: 'in_approval',
      current_step: 1,
      submitted_by: actor.userId,
      submitted_by_grant_id: actor.grantId ?? null,
      submitted_responsibility: actor.responsibility ?? null,
    }).returningAll().executeTakeFirstOrThrow();

    for (const s of steps) {
      await trx.insertInto('app.approval_step_instances').values({
        org_id: actor.orgId, instance_id: instance.id,
        step_no: s.step_no, name: s.name, resolver: s.resolver,
        role_code: s.role_code ?? null, sla_hours: s.sla_hours ?? null,
        status: 'pending',
      }).execute();
    }

    const opened = await this.openStep(trx, actor, instance.id, 1, input);

    await this.audit.write(trx, actor.orgId, {
      entityType: input.objectType, entityId: input.objectId, action: 'transition',
      projectId: input.projectId,
      changes: [{ field: 'state_class', old: 'submitted', new: 'in_approval' }],
      context: {
        approval_instance: instance.id, definition: def.name,
        version: version.version_no, steps: steps.length,
      },
    });

    return { ...instance, step: opened };
  }

  /**
   * Opens a step: resolves approvers, applies SoD, issues tasks.
   *
   * Three outcomes that are NOT errors and must not be treated as such:
   *   · the resolver returns the creator      → skip (SoD-01)
   *   · it returns someone who already decided → collapse (SoD-04), recorded
   *   · it returns nobody at all               → HALT, visibly, and tell an admin
   */
  private async openStep(
    trx: Transaction<DB>, actor: EngineActor,
    instanceId: string, stepNo: number, input: SubmitInput,
  ) {
    const step = assertVisible(
      await trx.selectFrom('app.approval_step_instances').selectAll()
        .where('instance_id', '=', instanceId).where('step_no', '=', stepNo)
        .executeTakeFirst(),
      'Approval step',
    );

    const candidates = await this.resolveApprovers(trx, step, input.projectId);

    // SoD-01, applied in the ENGINE rather than per module — so it holds for
    // every object type, present and future, without anyone remembering.
    const eligible = candidates.filter((c) => c.userId !== input.createdBy);

    const priorDeciders = await trx.selectFrom('app.approval_decisions')
      .select(['decided_by'])
      .where('instance_id', '=', instanceId)
      .where('decision', 'in', ['approve', 'reject'])
      .execute();
    const alreadyDecided = new Set(priorDeciders.map((d) => d.decided_by));

    const fresh = eligible.filter((c) => !alreadyDecided.has(c.userId));
    const collapsed = eligible.length > 0 && fresh.length === 0;

    if (collapsed) {
      // SoD-04. Silently letting one person tick two boxes is the worst
      // outcome; collapsing it VISIBLY is honest and keeps the record moving.
      await trx.updateTable('app.approval_step_instances')
        .set({ status: 'skipped', completed_at: new Date(), collapsed_from_step_no: stepNo })
        .where('id', '=', step.id).execute();
      this.log.warn(
        { instanceId, stepNo },
        'approval step collapsed: the only eligible approver already decided',
      );
      return this.advance(trx, actor, instanceId, stepNo, input);
    }

    if (fresh.length === 0) {
      await trx.updateTable('app.approval_step_instances')
        .set({ status: 'blocked' }).where('id', '=', step.id).execute();
      await trx.updateTable('app.approval_instances')
        .set({ status: 'blocked' }).where('id', '=', instanceId).execute();
      this.log.error(
        { instanceId, stepNo, resolver: step.resolver, roleCode: step.role_code },
        'approval blocked — no eligible approver',
      );
      return {
        step_no: stepNo, status: 'blocked' as const,
        message:
          `Blocked — no approver. Step "${step.name}" resolved to nobody who is ` +
          'allowed to decide it. This never auto-approves; an administrator must ' +
          'fix the workflow or the project team.',
      };
    }

    const dueAt = step.sla_hours
      ? new Date(Date.now() + step.sla_hours * 3_600_000) : null;

    await trx.updateTable('app.approval_step_instances')
      .set({ status: 'in_progress', started_at: new Date(), sla_due_at: dueAt })
      .where('id', '=', step.id).execute();

    for (const c of fresh) {
      await trx.insertInto('app.approval_tasks').values({
        org_id: actor.orgId, project_id: input.projectId,
        instance_id: instanceId, step_instance_id: step.id,
        assignee_user_id: c.userId, assignee_grant_id: c.grantId,
        status: 'pending', sla_due_at: dueAt,
      }).execute();
    }

    return {
      step_no: stepNo, status: 'in_progress' as const,
      name: step.name, approvers: fresh.length, sla_due_at: dueAt,
    };
  }

  private async resolveApprovers(
    trx: Transaction<DB>, step: { resolver: string; role_code: string | null },
    projectId: string,
  ): Promise<Array<{ userId: string; grantId: string }>> {
    if (step.resolver === 'project_manager') {
      const p = await trx.selectFrom('app.projects')
        .select(['accountable_manager_user_id']).where('id', '=', projectId).executeTakeFirst();
      if (!p) return [];
      const g = await trx.selectFrom('app.role_grants').select(['id'])
        .where('user_id', '=', p.accountable_manager_user_id)
        .where('revoked_at', 'is', null).executeTakeFirst();
      return [{ userId: p.accountable_manager_user_id, grantId: g?.id ?? '' }];
    }

    // role_in_project: whoever currently holds that role, scoped to this
    // project. Resolved AT STEP-OPEN time, not at submission — a person who
    // joined the project yesterday should be able to approve today.
    const rows = await trx.selectFrom('app.role_grants as g')
      .innerJoin('app.roles as r', 'r.id', 'g.role_id')
      .innerJoin('app.users as u', 'u.id', 'g.user_id')
      .select(['g.user_id', 'g.id as grant_id'])
      .where('r.code', '=', step.role_code ?? '')
      .where('g.scope_type', '=', 'project')
      .where('g.scope_id', '=', projectId)
      .where('g.revoked_at', 'is', null)
      .where('u.status', '=', 'active')
      .execute();
    return rows.map((r) => ({ userId: r.user_id, grantId: r.grant_id }));
  }

  /**
   * Records a decision.
   *
   * Immutable and append-only: there is deliberately no update path here, and
   * the database grants make sure there could not be one.
   */
  async decide(
    actor: EngineActor, taskId: string,
    input: { decision: ApprovalDecision; comment?: string },
  ) {
    return withTenant(
      this.db,
      { orgId: actor.orgId, userId: actor.userId, grantId: actor.grantId },
      async (trx) => {
        const task = assertVisible(
          await trx.selectFrom('app.approval_tasks').selectAll()
            .where('id', '=', taskId).forUpdate().executeTakeFirst(),
          'Approval task',
        );
        if (task.assignee_user_id !== actor.userId) {
          // 403 rather than 404: the task exists and they can see it in a list;
          // pretending otherwise would be confusing rather than protective.
          throw new ForbiddenException('That approval is assigned to someone else');
        }
        if (task.status !== 'pending') {
          throw new ConflictException('That approval has already been decided');
        }

        const instance = assertVisible(
          await trx.selectFrom('app.approval_instances').selectAll()
            .where('id', '=', task.instance_id).executeTakeFirst(),
          'Approval instance',
        );

        // Belt and braces. openStep already filtered the creator out, but the
        // rule is absolute and cheap to re-assert at the point of decision.
        const createdBy = (instance.context as { created_by?: string })?.created_by;
        if (createdBy) {
          this.sod.assertCanApprove({ userId: actor.userId }, { createdBy });
        }

        if ((input.decision === 'reject') && (input.comment ?? '').trim().length < 3) {
          throw new BadRequestException(
            'A rejection needs a reason the submitter can act on',
          );
        }
        if (input.decision === 'query' && (input.comment ?? '').trim().length < 3) {
          throw new BadRequestException('A query needs the actual question');
        }

        const step = await trx.selectFrom('app.approval_step_instances')
          .selectAll().where('id', '=', task.step_instance_id).executeTakeFirstOrThrow();

        await trx.insertInto('app.approval_decisions').values({
          org_id: actor.orgId,
          instance_id: instance.id,
          task_id: task.id,
          step_no: step.step_no,
          decision: input.decision,
          comment: input.comment ?? null,
          decided_by: actor.userId,
          decided_by_grant_id: actor.grantId ?? null,
          responsibility_label: actor.responsibility ?? null,
        }).execute();

        await trx.updateTable('app.approval_tasks')
          .set({ status: 'decided', responded_at: new Date() })
          .where('id', '=', task.id).execute();

        const objectInput: SubmitInput = {
          objectType: instance.object_type, objectId: instance.object_id,
          projectId: instance.project_id!, createdBy: createdBy ?? '',
        };

        let outcome: Record<string, unknown>;
        switch (input.decision) {
          case 'approve':
            await trx.updateTable('app.approval_step_instances')
              .set({ status: 'completed', completed_at: new Date() })
              .where('id', '=', step.id).execute();
            outcome = await this.advance(trx, actor, instance.id, step.step_no, objectInput);
            break;

          case 'reject':
            await trx.updateTable('app.approval_instances').set({
              status: 'rejected', state_class: 'rejected', completed_at: new Date(),
            }).where('id', '=', instance.id).execute();
            await this.withdrawSiblingTasks(trx, instance.id, step.id);
            outcome = { instance_status: 'rejected', object_state: 'rejected' };
            break;

          case 'hold':
            await trx.updateTable('app.approval_instances')
              .set({ status: 'on_hold' }).where('id', '=', instance.id).execute();
            // The task is re-issued so the same approver can come back to it:
            // a hold pauses the decision, it does not discard it.
            await trx.insertInto('app.approval_tasks').values({
              org_id: actor.orgId, project_id: instance.project_id,
              instance_id: instance.id, step_instance_id: step.id,
              assignee_user_id: actor.userId, assignee_grant_id: actor.grantId ?? null,
              status: 'pending', sla_due_at: task.sla_due_at,
            }).execute();
            outcome = { instance_status: 'on_hold' };
            break;

          case 'query':
            await trx.updateTable('app.approval_instances')
              .set({ status: 'query_raised' }).where('id', '=', instance.id).execute();
            // FR-201: the query routes back to the submitter, the item stays
            // open, and the ageing clock keeps running. A question that stops
            // the clock is a question that gets ignored.
            await trx.insertInto('app.comments').values({
              org_id: actor.orgId, project_id: instance.project_id,
              entity_type: instance.object_type, entity_id: instance.object_id,
              body: input.comment!,
              is_query: true,
              addressed_to_user_id: instance.submitted_by,
              author_id: actor.userId,
              author_grant_id: actor.grantId ?? null,
              author_responsibility: actor.responsibility ?? null,
            }).execute();
            await trx.insertInto('app.approval_tasks').values({
              org_id: actor.orgId, project_id: instance.project_id,
              instance_id: instance.id, step_instance_id: step.id,
              assignee_user_id: actor.userId, assignee_grant_id: actor.grantId ?? null,
              status: 'pending', sla_due_at: task.sla_due_at,
            }).execute();
            outcome = { instance_status: 'query_raised', blocks_closure: true };
            break;
        }

        await this.audit.write(trx, actor.orgId, {
          entityType: instance.object_type, entityId: instance.object_id,
          action: input.decision === 'approve' ? 'approve'
                : input.decision === 'reject' ? 'reject' : 'update',
          projectId: instance.project_id,
          context: {
            approval_instance: instance.id, step: step.step_no,
            decision: input.decision, comment: input.comment ?? null,
            ...outcome,
          },
        });

        return { decision: input.decision, step_no: step.step_no, ...outcome };
      },
    );
  }

  /** Moves to the next step, or completes the instance. */
  private async advance(
    trx: Transaction<DB>, actor: EngineActor,
    instanceId: string, fromStep: number, input: SubmitInput,
  ): Promise<Record<string, unknown>> {
    const next = await trx.selectFrom('app.approval_step_instances')
      .select(['step_no']).where('instance_id', '=', instanceId)
      .where('step_no', '>', fromStep).where('status', '=', 'pending')
      .orderBy('step_no').executeTakeFirst();

    if (next) {
      await trx.updateTable('app.approval_instances')
        .set({ current_step: next.step_no, status: 'in_progress' })
        .where('id', '=', instanceId).execute();
      const opened = await this.openStep(trx, actor, instanceId, next.step_no, input);
      return { instance_status: 'in_progress', next_step: opened };
    }

    // BR-21: ONLY the engine sets an approved state class.
    await trx.updateTable('app.approval_instances').set({
      status: 'approved', state_class: 'approved', completed_at: new Date(),
    }).where('id', '=', instanceId).execute();

    return { instance_status: 'approved', object_state: 'approved' };
  }

  private async withdrawSiblingTasks(
    trx: Transaction<DB>, instanceId: string, exceptStepId: string,
  ): Promise<void> {
    await trx.updateTable('app.approval_tasks')
      .set({ status: 'withdrawn' })
      .where('instance_id', '=', instanceId)
      .where('step_instance_id', '<>', exceptStepId)
      .where('status', '=', 'pending')
      .execute();
  }

  /**
   * THE inbox (FR-199).
   *
   * One list across every object type, sorted by ageing with the oldest first.
   * Approvers do not think in modules — they think "what is waiting on me, and
   * how long has it been there".
   */
  async inbox(actor: EngineActor, opts: { objectType?: string; projectId?: string } = {}) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx.selectFrom('app.approval_tasks as t')
        .innerJoin('app.approval_instances as i', 'i.id', 't.instance_id')
        .innerJoin('app.approval_step_instances as s', 's.id', 't.step_instance_id')
        .leftJoin('app.projects as p', 'p.id', 'i.project_id')
        .leftJoin('app.users as u', 'u.id', 'i.submitted_by')
        .select(['t.id as task_id', 't.assigned_at', 't.sla_due_at',
                 'i.id as instance_id', 'i.object_type', 'i.object_id', 'i.status',
                 'i.submitted_at', 'i.submitted_responsibility',
                 's.step_no', 's.name as step_name',
                 'p.code as project_code', 'p.name as project_name',
                 'u.name as submitted_by_name'])
        .where('t.assignee_user_id', '=', actor.userId)
        .where('t.status', '=', 'pending')
        // Oldest first: the item that has been waiting longest is the one that
        // matters, regardless of what kind of thing it is.
        .orderBy('t.assigned_at', 'asc');

      if (opts.objectType) qb = qb.where('i.object_type', '=', opts.objectType);
      if (opts.projectId) qb = qb.where('i.project_id', '=', opts.projectId);

      const rows = await qb.execute();
      const now = Date.now();
      const items = rows.map((r) => ({
        ...r,
        age_hours: Math.floor((now - new Date(r.assigned_at).getTime()) / 3_600_000),
        overdue: !!r.sla_due_at && new Date(r.sla_due_at).getTime() < now,
      }));

      return {
        count: items.length,
        oldest_age_hours: items.length ? items[0]!.age_hours : 0,
        overdue: items.filter((i) => i.overdue).length,
        items,
      };
    });
  }

  /** The full trail. Visible to anyone who can see the object — including the
   *  submitter, who must never have to ask where their record is (FR-215). */
  async trail(actor: EngineActor, objectType: string, objectId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const instance = await trx.selectFrom('app.approval_instances').selectAll()
        .where('object_type', '=', objectType).where('object_id', '=', objectId)
        .orderBy('submitted_at', 'desc').executeTakeFirst();
      if (!instance) return { instance: null, steps: [], decisions: [] };

      const [steps, decisions, pending] = await Promise.all([
        trx.selectFrom('app.approval_step_instances').selectAll()
          .where('instance_id', '=', instance.id).orderBy('step_no').execute(),
        trx.selectFrom('app.approval_decisions as d')
          .leftJoin('app.users as u', 'u.id', 'd.decided_by')
          .select(['d.step_no', 'd.decision', 'd.comment', 'd.decided_at',
                   'd.responsibility_label', 'u.name as decided_by_name'])
          .where('d.instance_id', '=', instance.id).orderBy('d.decided_at').execute(),
        trx.selectFrom('app.approval_tasks as t')
          .leftJoin('app.users as u', 'u.id', 't.assignee_user_id')
          .select(['u.name as assignee_name', 't.assigned_at', 't.sla_due_at'])
          .where('t.instance_id', '=', instance.id).where('t.status', '=', 'pending')
          .execute(),
      ]);

      return {
        instance: {
          id: instance.id, status: instance.status, state_class: instance.state_class,
          current_step: instance.current_step, submitted_at: instance.submitted_at,
          submitted_responsibility: instance.submitted_responsibility,
        },
        steps, decisions,
        // "Who has it now, and for how long" — the first question anyone asks.
        currently_with: pending,
      };
    });
  }
}
