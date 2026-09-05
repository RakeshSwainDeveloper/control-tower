import {
  Injectable, Inject, BadRequestException, ConflictException, GoneException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { PermissionService } from '../access/permission.service.js';
import { assertVisible } from '../access/scoped-query.js';
import type { Actor } from './projects.service.js';

interface RawRow { [column: string]: string }

/** The fields an import can populate, and whether a row is useless without one. */
const IMPORT_FIELDS = [
  { field: 'code',            required: true,  label: 'Code' },
  { field: 'description',     required: true,  label: 'Description' },
  { field: 'unitCode',        required: true,  label: 'Unit' },
  { field: 'plannedQty',      required: true,  label: 'Planned quantity' },
  { field: 'workCategoryCode', required: false, label: 'Work category' },
  { field: 'specReference',   required: false, label: 'Specification reference' },
] as const;

@Injectable()
export class WorkItemsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  private assertCanRead(actor: Actor, projectId: string): void {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.project.read', projectId)) {
      assertVisible(null, 'Project');
    }
  }
  private assertCanManage(actor: Actor, projectId: string): void {
    if (!this.permissions.holdsOnProject(actor.permissions, 'project.work_item.manage', projectId)) {
      assertVisible(null, 'Project');
    }
  }

  async list(actor: Actor, projectId: string, opts: { cursor?: string; limit: number; q?: string }) {
    this.assertCanRead(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx
        .selectFrom('app.work_items as w')
        .innerJoin('app.units as u', 'u.id', 'w.unit_id')
        .leftJoin('app.master_data as c', 'c.id', 'w.work_category_id')
        .select(['w.id', 'w.code', 'w.description', 'w.planned_qty', 'w.parent_id',
                 'w.spec_reference', 'w.is_active',
                 'u.code as unit_code', 'u.name as unit_name', 'u.dimension',
                 'c.code as category_code', 'c.name as category_name'])
        .where('w.project_id', '=', projectId)
        .orderBy('w.id', 'desc')
        .limit(opts.limit + 1);
      if (opts.q) {
        const like = `%${opts.q.toLowerCase()}%`;
        qb = qb.where((eb) => eb.or([
          eb(eb.fn('lower', ['w.code']), 'like', like),
          eb(eb.fn('lower', ['w.description']), 'like', like),
        ]));
      }
      if (opts.cursor) qb = qb.where('w.id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data,
        next_cursor: hasMore ? data[data.length - 1]!.id : null,
        has_more: hasMore,
      };
    });
  }

  async create(actor: Actor, projectId: string, input: {
    code: string; description: string; unitCode: string; plannedQty: string;
    parentId?: string | null; workCategoryCode?: string; specReference?: string;
  }) {
    this.assertCanManage(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const unit = await trx.selectFrom('app.units').select(['id'])
        .where('code', '=', input.unitCode).where('is_active', '=', true).executeTakeFirst();
      if (!unit) throw new BadRequestException(`Unknown unit '${input.unitCode}'`);

      let categoryId: string | null = null;
      if (input.workCategoryCode) {
        const cat = await trx.selectFrom('app.master_data').select('id')
          .where('kind', '=', 'work_category').where('code', '=', input.workCategoryCode)
          .executeTakeFirst();
        if (!cat) throw new BadRequestException(`Unknown work category '${input.workCategoryCode}'`);
        categoryId = cat.id;
      }

      const clash = await trx.selectFrom('app.work_items').select('id')
        .where('project_id', '=', projectId).where('code', '=', input.code).executeTakeFirst();
      if (clash) throw new ConflictException(`Work item '${input.code}' already exists`);

      const row = await trx.insertInto('app.work_items').values({
        org_id: actor.orgId, project_id: projectId,
        parent_id: input.parentId ?? null,
        code: input.code, description: input.description,
        unit_id: unit.id, planned_qty: input.plannedQty,
        work_category_id: categoryId,
        spec_reference: input.specReference ?? null,
        created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'work_item', entityId: row.id, action: 'create', projectId,
        changes: this.audit.diff(null, {
          code: row.code, description: row.description, planned_qty: row.planned_qty,
        }),
      });
      return row;
    });
  }

  // ── Location allocation (FR-124) ─────────────────────────────────
  async allocations(actor: Actor, projectId: string, workItemId: string) {
    this.assertCanRead(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const item = assertVisible(
        await trx.selectFrom('app.work_items').select(['id', 'code', 'planned_qty'])
          .where('id', '=', workItemId).where('project_id', '=', projectId).executeTakeFirst(),
        'Work item',
      );
      const rows = await trx
        .selectFrom('app.work_item_locations as a')
        .innerJoin('app.locations as l', 'l.id', 'a.location_id')
        .leftJoin('app.location_paths as p', 'p.location_id', 'l.id')
        .select(['a.id', 'a.location_id', 'a.planned_qty', 'l.code', 'l.name', 'p.display_path'])
        .where('a.work_item_id', '=', workItemId)
        .orderBy('p.display_path')
        .execute();

      const allocated = rows.reduce((sum, r) => sum + Number(r.planned_qty), 0);
      return {
        work_item: item,
        allocated: allocated.toFixed(4),
        unallocated: (Number(item.planned_qty) - allocated).toFixed(4),
        allocations: rows,
      };
    });
  }

  async allocate(actor: Actor, projectId: string, workItemId: string, input: {
    allocations: Array<{ locationId: string; plannedQty: string }>;
    mode: 'replace' | 'merge';
  }) {
    this.assertCanManage(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      assertVisible(
        await trx.selectFrom('app.work_items').select('id')
          .where('id', '=', workItemId).where('project_id', '=', projectId).executeTakeFirst(),
        'Work item',
      );

      if (input.mode === 'replace') {
        await trx.deleteFrom('app.work_item_locations')
          .where('work_item_id', '=', workItemId).execute();
      }

      // The over-allocation guard lives in a database trigger, so an import or
      // a future bulk path cannot route around it. Translate its error into
      // something a user can act on.
      try {
        for (const a of input.allocations) {
          await trx.insertInto('app.work_item_locations').values({
            org_id: actor.orgId, project_id: projectId,
            work_item_id: workItemId, location_id: a.locationId,
            planned_qty: a.plannedQty, created_by: actor.userId,
          }).onConflict((oc) => oc.columns(['work_item_id', 'location_id'])
            .doUpdateSet({ planned_qty: a.plannedQty })).execute();
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (/over its planned quantity/.test(msg)) throw new BadRequestException(msg);
        if (/locations_pkey|foreign key/.test(msg)) {
          throw new BadRequestException('One of those locations is not in this project');
        }
        throw e;
      }

      await this.audit.write(trx, actor.orgId, {
        entityType: 'work_item', entityId: workItemId, action: 'update', projectId,
        context: { allocation_mode: input.mode, locations: input.allocations.length },
      });
      const rows = await trx.selectFrom('app.work_item_locations')
        .select(['location_id', 'planned_qty'])
        .where('work_item_id', '=', workItemId)
        .execute();
      return {
        count: rows.length,
        total: rows.reduce((sum, r) => sum + Number(r.planned_qty), 0).toFixed(4),
      };
    });
  }

  // ── Import: upload → preview → confirm (FR-122) ──────────────────
  /**
   * Step 1+2. Validates every row and stages the result.
   *
   * NOTHING is written to work_items here. A half-applied import leaves a
   * project in a state nobody can reason about, and "delete the rows I just
   * made" is not a recovery procedure anyone should need.
   */
  async importPreview(actor: Actor, projectId: string, input: {
    filename?: string; columnMap: Record<string, string>; rows: RawRow[];
  }) {
    this.assertCanManage(actor, projectId);

    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const units = new Map(
        (await trx.selectFrom('app.units').select(['id', 'code'])
          .where('is_active', '=', true).execute()).map((u) => [u.code.toLowerCase(), u.id]),
      );
      const cats = new Map(
        (await trx.selectFrom('app.master_data').select(['id', 'code'])
          .where('kind', '=', 'work_category').execute()).map((c) => [c.code.toLowerCase(), c.id]),
      );
      const existing = new Set(
        (await trx.selectFrom('app.work_items').select('code')
          .where('project_id', '=', projectId).execute()).map((w) => w.code.toLowerCase()),
      );

      const valid: Array<Record<string, string>> = [];
      const errors: Array<{ row: number; field: string; message: string; value?: string }> = [];
      const seen = new Set<string>();

      input.rows.forEach((raw, idx) => {
        const rowNo = idx + 2;      // header is row 1, as the user sees it
        const get = (field: string): string =>
          (raw[input.columnMap[field] ?? field] ?? '').toString().trim();

        const rec: Record<string, string> = {};
        let ok = true;

        for (const f of IMPORT_FIELDS) {
          const v = get(f.field);
          if (!v && f.required) {
            errors.push({ row: rowNo, field: f.field, message: `${f.label} is required` });
            ok = false;
          }
          if (v) rec[f.field] = v;
        }
        if (!ok) return;

        const codeKey = rec['code']!.toLowerCase();
        if (existing.has(codeKey)) {
          errors.push({ row: rowNo, field: 'code',
            message: 'A work item with this code already exists in the project',
            value: rec['code'] });
          return;
        }
        if (seen.has(codeKey)) {
          errors.push({ row: rowNo, field: 'code',
            message: 'This code appears more than once in the file', value: rec['code'] });
          return;
        }

        if (!units.has(rec['unitCode']!.toLowerCase())) {
          errors.push({ row: rowNo, field: 'unitCode',
            message: 'Unknown unit', value: rec['unitCode'] });
          return;
        }
        if (rec['workCategoryCode'] && !cats.has(rec['workCategoryCode'].toLowerCase())) {
          errors.push({ row: rowNo, field: 'workCategoryCode',
            message: 'Unknown work category', value: rec['workCategoryCode'] });
          return;
        }
        if (!/^\d{1,14}(\.\d{1,4})?$/.test(rec['plannedQty']!)) {
          errors.push({ row: rowNo, field: 'plannedQty',
            message: 'Planned quantity must be a positive number with at most 4 decimals',
            value: rec['plannedQty'] });
          return;
        }

        seen.add(codeKey);
        valid.push(rec);
      });

      const job = await trx.insertInto('app.import_jobs').values({
        org_id: actor.orgId, project_id: projectId,
        entity_type: 'work_item', filename: input.filename ?? null,
        status: 'previewing',
        column_map: JSON.stringify(input.columnMap),
        total_rows: input.rows.length,
        valid_rows: valid.length,
        error_rows: errors.length,
        rows: JSON.stringify(valid),
        errors: JSON.stringify(errors),
        created_by: actor.userId,
      }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();

      return {
        job_id: job.id,
        expires_at: job.expires_at,
        total_rows: input.rows.length,
        valid_rows: valid.length,
        error_rows: errors.length,
        // A sample, not the whole file: the point is to let a human judge
        // whether the mapping is right, not to re-render the spreadsheet.
        preview: valid.slice(0, 20),
        errors: errors.slice(0, 100),
        can_confirm: valid.length > 0,
      };
    });
  }

  /** Step 3. Only now is anything written, and all of it in one transaction. */
  async importConfirm(actor: Actor, projectId: string, jobId: string) {
    this.assertCanManage(actor, projectId);
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const job = assertVisible(
        await trx.selectFrom('app.import_jobs').selectAll()
          .where('id', '=', jobId).where('project_id', '=', projectId)
          .forUpdate().executeTakeFirst(),
        'Import job',
      );
      if (job.status !== 'previewing') {
        throw new GoneException(`This import has already been ${job.status}`);
      }
      if (job.expires_at < new Date()) {
        throw new GoneException('This import preview has expired. Upload the file again.');
      }

      const rows = job.rows as unknown as Array<Record<string, string>>;
      if (rows.length === 0) throw new BadRequestException('This import has no valid rows');

      const units = new Map(
        (await trx.selectFrom('app.units').select(['id', 'code']).execute())
          .map((u) => [u.code.toLowerCase(), u.id]),
      );
      const cats = new Map(
        (await trx.selectFrom('app.master_data').select(['id', 'code'])
          .where('kind', '=', 'work_category').execute()).map((c) => [c.code.toLowerCase(), c.id]),
      );

      const inserted = await trx.insertInto('app.work_items').values(
        rows.map((r, i) => ({
          org_id: actor.orgId, project_id: projectId,
          code: r['code']!, description: r['description']!,
          unit_id: units.get(r['unitCode']!.toLowerCase())!,
          planned_qty: r['plannedQty']!,
          work_category_id: r['workCategoryCode']
            ? cats.get(r['workCategoryCode'].toLowerCase()) ?? null : null,
          spec_reference: r['specReference'] ?? null,
          sort_order: i,
          created_by: actor.userId,
        })),
      ).returning(['id']).execute();

      await trx.updateTable('app.import_jobs')
        .set({ status: 'confirmed', confirmed_at: new Date() })
        .where('id', '=', jobId).execute();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'import_job', entityId: jobId, action: 'import', projectId,
        context: {
          entity: 'work_item', imported: inserted.length,
          filename: job.filename, total_rows: job.total_rows, skipped: job.error_rows,
        },
      });

      return { imported: inserted.length, skipped: job.error_rows };
    });
  }
}
