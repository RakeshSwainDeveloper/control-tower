import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@ct/db';
import { SyncRegistry } from '../sync/sync.registry.js';
import {
  SyncRejection,
  type AppliedItem, type SyncActor, type SyncHandler, type SyncItem,
} from '../sync/sync.types.js';
import { PermissionService } from '../access/permission.service.js';
import { AuditService } from '../../common/audit.service.js';

/**
 * The daily report header, offline — and the first real consumer of
 * KEEP_BOTH_AND_FLAG.
 *
 * The situation this policy exists for: two supervisors, both offline, both
 * submit a report for the same project and the same day. Neither is wrong.
 * Last-write-wins would silently destroy one person's afternoon, and picking a
 * winner by timestamp is arbitrary when both devices had wrong clocks.
 *
 * So BOTH are kept. The second becomes a merge twin carrying
 * merged_from_report_id, both are flagged, and the project manager decides.
 * The system's job here is to refuse to guess.
 */
@Injectable()
export class DailyReportSyncHandler implements SyncHandler, OnModuleInit {
  readonly entity = 'daily_report';
  readonly conflictPolicy = 'keep_both_and_flag' as const;
  readonly permission = 'field.daily_report.create';

  constructor(
    private readonly registry: SyncRegistry,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    const p = item.payload as {
      project_id?: string; report_date?: string; weather?: string;
      manpower?: unknown[]; notes?: string;
    };
    if (!p.project_id || !p.report_date) {
      throw new SyncRejection('This report is missing its project or date. It has been kept.');
    }

    const perms = await this.permissions.compile(actor.orgId, actor.userId);
    if (!this.permissions.holdsOnProject(perms, 'field.daily_report.create', p.project_id)) {
      throw new SyncRejection(
        'You no longer have permission to submit a report for that project.',
      );
    }
    const grant = perms.keys['field.daily_report.create'];

    const existing = await trx.selectFrom('app.daily_reports')
      .select(['id', 'created_by', 'locked_at', 'state_class'])
      .where('project_id', '=', p.project_id)
      .where('report_date', '=', p.report_date)
      .where('amends_report_id', 'is', null)
      .where('merged_from_report_id', 'is', null)
      .executeTakeFirst();

    // Same author, same day: this is the device catching up with itself, not a
    // conflict. Update in place.
    if (existing && existing.created_by === actor.userId && !existing.locked_at) {
      const row = await trx.updateTable('app.daily_reports').set({
        weather: p.weather ?? null,
        manpower: JSON.stringify(p.manpower ?? []),
        notes: p.notes ?? null,
        updated_by: actor.userId,
      }).where('id', '=', existing.id).returning(['id', 'version']).executeTakeFirstOrThrow();
      return { serverId: row.id, version: row.version };
    }

    // ── KEEP BOTH ────────────────────────────────────────────────
    if (existing) {
      const twin = await trx.insertInto('app.daily_reports').values({
        org_id: actor.orgId,
        project_id: p.project_id,
        report_date: p.report_date,
        weather: p.weather ?? null,
        manpower: JSON.stringify(p.manpower ?? []),
        notes: p.notes ?? null,
        state_class: 'draft',
        // This is what makes the twin legal against
        // daily_reports_one_original_per_day — and what makes it findable.
        merged_from_report_id: existing.id,
        has_merge_conflict: true,
        created_by: actor.userId,
        created_by_grant_id: grant?.grantId ?? null,
        client_uuid: item.client_uuid,
      }).returning(['id', 'version']).executeTakeFirstOrThrow();

      // Flag the ORIGINAL too. A conflict that only marks the newcomer leaves
      // whoever opens the first report unaware there is a second.
      await trx.updateTable('app.daily_reports')
        .set({ has_merge_conflict: true })
        .where('id', '=', existing.id).execute();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'daily_report', entityId: twin.id, action: 'create',
        projectId: p.project_id,
        context: {
          merge_conflict: true,
          kept_both: true,
          other_report_id: existing.id,
          report_date: p.report_date,
          note: 'Two authors submitted for the same day from offline devices. ' +
                'Both retained; neither overwritten.',
        },
        responsibilityLabel: grant?.responsibilityLabel ?? null,
      });

      return {
        serverId: twin.id,
        version: twin.version,
        conflict: {
          policy: 'keep_both_and_flag',
          keptBoth: true,
          otherId: existing.id,
          detail:
            `Another supervisor already submitted a report for ${p.report_date}. ` +
            'Both were kept and flagged for the project manager.',
        },
      };
    }

    const row = await trx.insertInto('app.daily_reports').values({
      org_id: actor.orgId,
      project_id: p.project_id,
      report_date: p.report_date,
      weather: p.weather ?? null,
      manpower: JSON.stringify(p.manpower ?? []),
      notes: p.notes ?? null,
      state_class: 'draft',
      created_by: actor.userId,
      created_by_grant_id: grant?.grantId ?? null,
      client_uuid: item.client_uuid,
    }).returning(['id', 'version']).executeTakeFirstOrThrow();

    return { serverId: row.id, version: row.version };
  }
}
