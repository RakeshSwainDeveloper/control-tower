import { Injectable, Inject, BadRequestException, ConflictException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { StepSpec } from './approval.engine.js';

/**
 * Approval configuration.
 *
 * Phase 6 built the engine and its tables but no way to put a workflow into
 * them — every instance would have failed BR-22 ("no approval workflow is
 * configured") forever. This is the surface that fills them.
 *
 * The one rule that shapes this whole file: **a published version is
 * immutable** (BR-20). Editing a workflow does not change it; it publishes a
 * new version. Instances already in flight keep finishing under the rules they
 * started on, which is the only way an approval trail means anything six
 * months later.
 */
export interface ConfigActor { userId: string; orgId: string }

@Injectable()
export class ApprovalConfigService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
  ) {}

  async list(actor: ConfigActor, objectType?: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let q = trx.selectFrom('app.approval_definitions as d')
        .select(['d.id', 'd.object_type', 'd.scope_type', 'd.scope_id',
                 'd.name', 'd.is_active', 'd.created_at'])
        .orderBy('d.object_type').orderBy('d.scope_type');
      if (objectType) q = q.where('d.object_type', '=', objectType);
      const defs = await q.execute();
      if (defs.length === 0) return [];

      const versions = await trx.selectFrom('app.approval_versions')
        .select(['id', 'definition_id', 'version_no', 'spec', 'effective_from',
                 'activated_by', 'activated_at'])
        .where('definition_id', 'in', defs.map((d) => d.id))
        .orderBy('version_no', 'desc')
        .execute();

      // In-flight counts: a workflow with live instances cannot be deleted, and
      // the person editing it should see why before they try.
      const live = await trx.selectFrom('app.approval_instances')
        .select(['definition_id', ({ fn }) => fn.count<string>('id').as('n')])
        .where('status', 'in', ['in_progress', 'on_hold', 'query_raised'])
        .groupBy('definition_id').execute();

      return defs.map((d) => {
        const mine = versions.filter((v) => v.definition_id === d.id);
        return {
          ...d,
          current_version: mine[0]?.version_no ?? null,
          steps: (mine[0]?.spec as StepSpec[] | undefined) ?? [],
          in_flight: Number(live.find((l) => l.definition_id === d.id)?.n ?? 0),
          versions: mine.map((v) => ({
            id: v.id, version_no: v.version_no, spec: v.spec,
            activated_at: v.activated_at, activated_by: v.activated_by,
          })),
        };
      });
    });
  }

  async createDefinition(actor: ConfigActor, input: {
    objectType: string; name: string; scopeType: 'org' | 'project'; scopeId?: string;
    steps: StepSpec[];
  }) {
    this.validate(input.steps);
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const clash = await trx.selectFrom('app.approval_definitions').select('id')
        .where('object_type', '=', input.objectType)
        .where('scope_type', '=', input.scopeType)
        .where('scope_id', input.scopeId ? '=' : 'is', input.scopeId ?? null)
        .executeTakeFirst();
      if (clash) {
        throw new ConflictException(
          `A workflow for '${input.objectType}' already exists at this scope. ` +
          'Publish a new version of it rather than creating a second one — two ' +
          'workflows for the same object at the same scope have no defined winner.',
        );
      }

      const def = await trx.insertInto('app.approval_definitions').values({
        org_id: actor.orgId, object_type: input.objectType,
        scope_type: input.scopeType, scope_id: input.scopeId ?? null,
        name: input.name, is_active: true, created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();

      const version = await this.publishInTrx(trx, actor, def.id, input.steps);

      await this.audit.write(trx, actor.orgId, {
        entityType: 'approval_definition', entityId: def.id, action: 'config_change',
        ...(input.scopeType === 'project' && input.scopeId ? { projectId: input.scopeId } : {}),
        changes: this.audit.diff(null, {
          object_type: input.objectType, name: input.name,
          scope_type: input.scopeType, steps: input.steps.length,
        }),
      });
      return { ...def, current_version: version.version_no, steps: input.steps };
    });
  }

  /** Publishing never mutates: it appends a version and leaves history intact. */
  async publish(actor: ConfigActor, definitionId: string, steps: StepSpec[]) {
    this.validate(steps);
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const def = assertVisible(
        await trx.selectFrom('app.approval_definitions').selectAll()
          .where('id', '=', definitionId).executeTakeFirst(),
        'Approval workflow',
      );
      const version = await this.publishInTrx(trx, actor, definitionId, steps);

      await this.audit.write(trx, actor.orgId, {
        entityType: 'approval_definition', entityId: definitionId, action: 'config_change',
        ...(def.scope_type === 'project' && def.scope_id ? { projectId: def.scope_id } : {}),
        context: { published_version: version.version_no, steps: steps.length },
      });
      return version;
    });
  }

  private async publishInTrx(
    trx: Parameters<typeof this.audit.write>[0], actor: ConfigActor,
    definitionId: string, steps: StepSpec[],
  ) {
    const next = (await sql<{ n: number }>`
      SELECT COALESCE(max(version_no), 0) + 1 AS n
      FROM app.approval_versions WHERE definition_id = ${definitionId}
    `.execute(trx)).rows[0]!.n;

    return trx.insertInto('app.approval_versions').values({
      org_id: actor.orgId, definition_id: definitionId, version_no: next,
      spec: JSON.stringify(steps),
      activated_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async setActive(actor: ConfigActor, definitionId: string, isActive: boolean) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      assertVisible(
        await trx.selectFrom('app.approval_definitions').select('id')
          .where('id', '=', definitionId).executeTakeFirst(),
        'Approval workflow',
      );
      if (!isActive) {
        const live = await trx.selectFrom('app.approval_instances').select('id')
          .where('definition_id', '=', definitionId)
          .where('status', 'in', ['in_progress', 'on_hold', 'query_raised'])
          .executeTakeFirst();
        if (live) {
          throw new ConflictException(
            'Something is still waiting for approval under this workflow. ' +
            'Deactivating it now would strand those items with nobody to decide them.',
          );
        }
      }
      const row = await trx.updateTable('app.approval_definitions')
        .set({ is_active: isActive, updated_by: actor.userId })
        .where('id', '=', definitionId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'approval_definition', entityId: definitionId, action: 'config_change',
        changes: [{ field: 'is_active', old: !isActive, new: isActive }],
      });
      return row;
    });
  }

  /**
   * The MVP engine is sequential, with two resolvers. Rejecting a spec it
   * cannot execute here — loudly, at configuration time — is far better than
   * discovering it when a supervisor's daily report will not route.
   */
  private validate(steps: StepSpec[]): void {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new BadRequestException('A workflow needs at least one step.');
    }
    if (steps.length > 5) {
      throw new BadRequestException(
        `${steps.length} approval steps. Anything past three is a queue, not a control — ` +
        'the MVP caps it at five.',
      );
    }
    const seen = new Set<number>();
    for (const [i, s] of steps.entries()) {
      if (s.step_no !== i + 1) {
        throw new BadRequestException(
          `Step ${i + 1} is numbered ${s.step_no}. Steps are sequential and must be 1, 2, 3…`,
        );
      }
      if (seen.has(s.step_no)) throw new BadRequestException(`Duplicate step ${s.step_no}`);
      seen.add(s.step_no);
      if (!s.name?.trim()) throw new BadRequestException(`Step ${s.step_no} has no name`);
      if (s.resolver !== 'role_in_project' && s.resolver !== 'project_manager') {
        throw new BadRequestException(
          `Step ${s.step_no}: unknown resolver '${s.resolver}'. The MVP has two: ` +
          "'project_manager' and 'role_in_project'.",
        );
      }
      if (s.resolver === 'role_in_project' && !s.role_code?.trim()) {
        throw new BadRequestException(
          `Step ${s.step_no} routes to a role but names none. It would resolve to nobody, ` +
          'and the engine would halt the item as Blocked.',
        );
      }
      if (s.sla_hours !== undefined && (s.sla_hours < 1 || s.sla_hours > 720)) {
        throw new BadRequestException(`Step ${s.step_no}: an SLA must be between 1 and 720 hours`);
      }
    }
  }
}
