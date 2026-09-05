import { Injectable, Inject, BadRequestException, ConflictException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { Actor } from './projects.service.js';

interface LevelSpec {
  levelName: string;
  items?: Array<{ code: string; name: string }>;
  range?: { from: number; to: number; codeTemplate: string; nameTemplate: string; pad: number };
}

const MAX_BULK_NODES = 5000;

@Injectable()
export class LocationsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  private assertCanRead(actor: Actor, projectId: string): void {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.location.read', projectId)) {
      assertVisible(null, 'Project');
    }
  }

  /** The whole tree, ordered so a client can render it without sorting. */
  async tree(actor: Actor, projectId: string) {
    this.assertCanRead(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const rows = await trx
        .selectFrom('app.locations as l')
        .leftJoin('app.location_paths as p', 'p.location_id', 'l.id')
        .select(['l.id', 'l.parent_id', 'l.code', 'l.name', 'l.level_index',
                 'l.level_name', 'l.status', 'l.sort_order', 'l.is_active',
                 'p.display_path', 'p.depth'])
        .where('l.project_id', '=', projectId)
        .orderBy('p.display_path')
        .execute();
      return rows;
    });
  }

  /**
   * Everything at or under a node.
   *
   * `path <@ ancestor` on a GIST index, not a recursive CTE: this runs on every
   * location-filtered list in the product, so it has to be an index lookup.
   */
  async subtree(actor: Actor, projectId: string, locationId: string) {
    this.assertCanRead(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const anchor = assertVisible(
        await trx.selectFrom('app.locations').select(['id', 'path', 'name'])
          .where('id', '=', locationId).where('project_id', '=', projectId)
          .executeTakeFirst(),
        'Location',
      );
      const r = await sql<{
        id: string; code: string; name: string; display_path: string; depth: number;
      }>`
        SELECT l.id, l.code, l.name, p.display_path, p.depth
        FROM app.locations l
        LEFT JOIN app.location_paths p ON p.location_id = l.id
        WHERE l.project_id = ${projectId}
          AND l.path <@ ${anchor.path}::ltree
        ORDER BY p.display_path
      `.execute(trx);
      return { anchor: { id: anchor.id, name: anchor.name }, nodes: r.rows };
    });
  }

  async create(actor: Actor, projectId: string, input: {
    parentId?: string | null; code: string; name: string;
    levelName?: string; attributes: Record<string, unknown>; sortOrder: number;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.location.create', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      if (input.parentId) {
        assertVisible(
          await trx.selectFrom('app.locations').select('id')
            .where('id', '=', input.parentId).where('project_id', '=', projectId)
            .executeTakeFirst(),
          'Parent location',
        );
      }
      const row = await trx.insertInto('app.locations').values({
        org_id: actor.orgId,
        project_id: projectId,
        parent_id: input.parentId ?? null,
        code: input.code,
        name: input.name,
        level_name: input.levelName ?? null,
        attributes: JSON.stringify(input.attributes),
        sort_order: input.sortOrder,
        path: sql`''::ltree` as never,   // the BEFORE trigger computes the real path
        created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow()
        .catch((e: Error) => {
          if (/locations_org_id_project_id_path_key/.test(e.message)) {
            throw new ConflictException(
              `A location with code '${input.code}' already exists under that parent`,
            );
          }
          throw e;
        });

      await this.audit.write(trx, actor.orgId, {
        entityType: 'location', entityId: row.id, action: 'create', projectId,
        changes: this.audit.diff(null, { code: row.code, name: row.name, path: row.path }),
      });
      return row;
    });
  }

  /**
   * Bulk creation from a level pattern (FR-106).
   *
   * A 14-storey tower with 6 flats and 4 rooms each is 1,176 nodes. Entering
   * those by hand does not happen, so a tree that cannot be generated is a tree
   * that stays empty — and every location-tagged record then has nowhere to go.
   */
  async bulkCreate(actor: Actor, projectId: string, input: {
    parentId?: string | null; levels: LevelSpec[];
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.location.create', projectId)) {
      assertVisible(null, 'Project');
    }

    const expanded = input.levels.map(expandLevel);
    const total = expanded.reduce((acc, l) => acc * l.length, 1);
    if (total > MAX_BULK_NODES) {
      throw new BadRequestException(
        `That pattern would create ${total.toLocaleString()} locations; the limit is ` +
          `${MAX_BULK_NODES.toLocaleString()}. Create the top levels first, then ` +
          `generate beneath one of them.`,
      );
    }

    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      if (input.parentId) {
        assertVisible(
          await trx.selectFrom('app.locations').select('id')
            .where('id', '=', input.parentId).where('project_id', '=', projectId)
            .executeTakeFirst(),
          'Parent location',
        );
      }

      let frontier: Array<string | null> = [input.parentId ?? null];
      let created = 0;

      // Level by level, so every row's parent already exists and the path
      // trigger has something to build on.
      for (let depth = 0; depth < expanded.length; depth++) {
        const spec = input.levels[depth]!;
        const items = expanded[depth]!;
        const nextFrontier: string[] = [];

        for (const parent of frontier) {
          const values = items.map((it, i) => ({
            org_id: actor.orgId,
            project_id: projectId,
            parent_id: parent,
            code: it.code,
            name: it.name,
            level_name: spec.levelName,
            sort_order: i,
            path: sql`''::ltree` as never,
            created_by: actor.userId,
          }));
          const rows = await trx.insertInto('app.locations').values(values)
            .onConflict((oc) => oc.doNothing())   // re-running a pattern must not explode
            .returning(['id']).execute();
          nextFrontier.push(...rows.map((r) => r.id));
          created += rows.length;
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      await this.audit.write(trx, actor.orgId, {
        entityType: 'location', entityId: input.parentId ?? projectId,
        action: 'create', projectId,
        context: {
          bulk: true, created,
          pattern: input.levels.map((l) => l.levelName),
        },
      });
      return { created, levels: input.levels.map((l) => l.levelName) };
    });
  }

  async update(actor: Actor, projectId: string, locationId: string, patch: {
    name?: string; levelName?: string; status?: string; sortOrder?: number;
  }) {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.location.update', projectId)) {
      assertVisible(null, 'Project');
    }
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const before = assertVisible(
        await trx.selectFrom('app.locations').selectAll()
          .where('id', '=', locationId).where('project_id', '=', projectId).executeTakeFirst(),
        'Location',
      );
      const set: Record<string, unknown> = { updated_by: actor.userId };
      if (patch.name !== undefined) set['name'] = patch.name;
      if (patch.levelName !== undefined) set['level_name'] = patch.levelName;
      if (patch.status !== undefined) set['status'] = patch.status;
      if (patch.sortOrder !== undefined) set['sort_order'] = patch.sortOrder;

      const after = await trx.updateTable('app.locations').set(set as never)
        .where('id', '=', locationId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'location', entityId: locationId, action: 'update', projectId,
        changes: this.audit.diff(before, after),
      });
      return after;
    });
  }
}

function expandLevel(level: LevelSpec): Array<{ code: string; name: string }> {
  if (level.items) return level.items;
  const r = level.range!;
  if (r.to < r.from) {
    throw new BadRequestException(`Range ${r.from}–${r.to} counts backwards`);
  }
  const out: Array<{ code: string; name: string }> = [];
  for (let n = r.from; n <= r.to; n++) {
    const token = r.pad > 0 ? String(n).padStart(r.pad, '0') : String(n);
    out.push({
      code: r.codeTemplate.replaceAll('{n}', token),
      name: r.nameTemplate.replaceAll('{n}', token),
    });
  }
  return out;
}
