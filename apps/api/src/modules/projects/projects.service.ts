import {
  Injectable, Inject, ConflictException, BadRequestException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import type { Page } from '@ct/contracts';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { assertVisible, scopeFor } from '../access/scoped-query.js';
import type { CompiledPermissions } from '../access/permission.service.js';

export interface Actor {
  userId: string;
  orgId: string;
  permissions: CompiledPermissions;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Lists the projects this user may see.
   *
   * The scope comes from the compiled permission set, not from a role name: an
   * org-scoped grant sees everything, a project-scoped grant sees exactly the
   * projects it names. A user holding the key nowhere gets an empty page rather
   * than an error, because "you have no projects" and "you may not ask" look
   * the same from outside and should.
   */
  async list(
    actor: Actor,
    opts: { cursor?: string; limit: number; state?: string; q?: string },
  ): Promise<Page<Record<string, unknown>>> {
    const scope = scopeFor(actor.permissions, 'project.project.read');
    if (scope.denyAll) return { data: [], next_cursor: null, has_more: false };

    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx
        .selectFrom('app.projects as p')
        .leftJoin('app.users as m', 'm.id', 'p.accountable_manager_user_id')
        .select([
          'p.id', 'p.code', 'p.name', 'p.client_name', 'p.state_class',
          'p.planned_start', 'p.planned_finish', 'p.actual_start', 'p.actual_finish',
          'p.location_label_scheme', 'p.created_at',
          'm.name as accountable_manager',
        ])
        .orderBy('p.id', 'desc')
        .limit(opts.limit + 1);

      if (scope.projectIds !== null) qb = qb.where('p.id', 'in', scope.projectIds);
      if (opts.state) qb = qb.where('p.state_class', '=', opts.state as 'draft');
      if (opts.q) {
        const like = `%${opts.q.toLowerCase()}%`;
        qb = qb.where((eb) => eb.or([
          eb(eb.fn('lower', ['p.name']), 'like', like),
          eb(eb.fn('lower', ['p.code']), 'like', like),
        ]));
      }
      if (opts.cursor) qb = qb.where('p.id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data: data as unknown as Record<string, unknown>[],
        next_cursor: hasMore ? (data[data.length - 1]!.id as string) : null,
        has_more: hasMore,
      };
    });
  }

  async get(actor: Actor, projectId: string) {
    // 404-not-403 (FR-566): a project the caller may not see must be
    // indistinguishable from one that does not exist.
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.project.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const project = assertVisible(
        await trx
          .selectFrom('app.projects as p')
          .leftJoin('app.users as m', 'm.id', 'p.accountable_manager_user_id')
          .leftJoin('app.users as c', 'c.id', 'p.commercial_owner_user_id')
          .select([
            'p.id', 'p.code', 'p.name', 'p.description', 'p.client_name',
            'p.state_class', 'p.planned_start', 'p.planned_finish',
            'p.actual_start', 'p.actual_finish', 'p.location_label_scheme',
            'p.timezone', 'p.created_at', 'p.version',
            'm.name as accountable_manager', 'c.name as commercial_owner',
          ])
          .where('p.id', '=', projectId)
          .executeTakeFirst(),
        'Project',
      );

      const counts = await sql<{ locations: string; work_items: string }>`
        SELECT
          (SELECT count(*) FROM app.locations  WHERE project_id = ${projectId} AND is_active) AS locations,
          (SELECT count(*) FROM app.work_items WHERE project_id = ${projectId} AND is_active) AS work_items
      `.execute(trx);

      return {
        ...project,
        counts: {
          locations: Number(counts.rows[0]!.locations),
          work_items: Number(counts.rows[0]!.work_items),
        },
      };
    });
  }

  async create(actor: Actor, input: {
    code: string; name: string; description?: string; clientName?: string;
    plannedStart?: string; plannedFinish?: string;
    accountableManagerUserId: string; commercialOwnerUserId: string;
    locationLabelScheme: string[]; timezone: string;
  }) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const clash = await trx.selectFrom('app.projects').select('id')
        .where('code', '=', input.code).executeTakeFirst();
      if (clash) throw new ConflictException(`Project code '${input.code}' already exists`);

      // Both roles must name a real, active user in this tenant. RLS already
      // confines the lookup to the tenant; this catches a deactivated or
      // mistyped id before the FK does, so the message is useful.
      for (const [field, id] of [
        ['accountableManagerUserId', input.accountableManagerUserId],
        ['commercialOwnerUserId', input.commercialOwnerUserId],
      ] as const) {
        const u = await trx.selectFrom('app.users').select(['id', 'status'])
          .where('id', '=', id).executeTakeFirst();
        if (!u) throw new BadRequestException(`${field} does not name a user in this organization`);
        if (u.status !== 'active') {
          throw new BadRequestException(`${field} names a user who is ${u.status}`);
        }
      }

      const company = await trx.selectFrom('app.companies').select('id')
        .where('is_default', '=', true).executeTakeFirst();
      if (!company) throw new BadRequestException('This organization has no default company');

      const project = await trx.insertInto('app.projects').values({
        org_id: actor.orgId,
        company_id: company.id,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        client_name: input.clientName ?? null,
        planned_start: input.plannedStart ?? null,
        planned_finish: input.plannedFinish ?? null,
        accountable_manager_user_id: input.accountableManagerUserId,
        commercial_owner_user_id: input.commercialOwnerUserId,
        location_label_scheme: input.locationLabelScheme,
        timezone: input.timezone,
        state_class: 'draft',
        created_by: actor.userId,
        created_by_grant_id: actor.permissions.keys['project.project.create']?.grantId ?? null,
      }).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'project', entityId: project.id, action: 'create',
        projectId: project.id,
        changes: this.audit.diff(null, {
          code: project.code, name: project.name,
          accountable_manager_user_id: project.accountable_manager_user_id,
          commercial_owner_user_id: project.commercial_owner_user_id,
        }),
      });
      return project;
    });
  }

  async update(actor: Actor, projectId: string, patch: Record<string, unknown>) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.project.update', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.projects').selectAll()
          .where('id', '=', projectId).executeTakeFirst(),
        'Project',
      );

      const map: Record<string, string> = {
        name: 'name', description: 'description', clientName: 'client_name',
        plannedStart: 'planned_start', plannedFinish: 'planned_finish',
        accountableManagerUserId: 'accountable_manager_user_id',
        commercialOwnerUserId: 'commercial_owner_user_id',
        locationLabelScheme: 'location_label_scheme', timezone: 'timezone',
      };
      const set: Record<string, unknown> = { updated_by: actor.userId };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && map[k]) set[map[k]] = v;
      }
      if (Object.keys(set).length === 1) return before;

      const after = await trx.updateTable('app.projects').set(set as never)
        .where('id', '=', projectId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'project', entityId: projectId, action: 'update',
        projectId, changes: this.audit.diff(before, after),
      });
      return after;
    });
  }

  /** Project team = users holding a project-scoped grant on it (FR-102). */
  async members(actor: Actor, projectId: string) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.project.read', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId }, (trx) =>
      trx.selectFrom('app.role_grants as g')
        .innerJoin('app.users as u', 'u.id', 'g.user_id')
        .innerJoin('app.roles as r', 'r.id', 'g.role_id')
        .select(['u.id as user_id', 'u.name', 'u.email', 'u.phone', 'u.status',
                 'r.code as role_code', 'g.responsibility_label',
                 'g.valid_from', 'g.valid_to'])
        .where('g.scope_type', '=', 'project')
        .where('g.scope_id', '=', projectId)
        .where('g.revoked_at', 'is', null)
        .orderBy('u.name')
        .execute(),
    );
  }
}
