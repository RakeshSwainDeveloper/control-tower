import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@ct/db';
import { SyncRegistry } from '../sync/sync.registry.js';
import {
  SyncRejection,
  type AppliedItem, type SyncActor, type SyncHandler, type SyncItem,
} from '../sync/sync.types.js';
import { ProgressService } from './progress.service.js';
import { PermissionService } from '../access/permission.service.js';

/**
 * Progress entries, offline.
 *
 * Policy: accept_as_new. Two supervisors recording different work in different
 * flats are not in disagreement about anything, so there is nothing to resolve.
 * The engine's idempotency on client_uuid is what stops a retry duplicating —
 * not a uniqueness rule about the work itself, because the same quantity of the
 * same item at the same location on the same day is a perfectly ordinary thing
 * to record twice.
 */
@Injectable()
export class ProgressSyncHandler implements SyncHandler, OnModuleInit {
  readonly entity = 'progress_entry';
  readonly conflictPolicy = 'accept_as_new' as const;
  readonly permission = 'field.progress.create';

  constructor(
    private readonly registry: SyncRegistry,
    private readonly progress: ProgressService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    const p = item.payload as {
      project_id?: string; work_item_id?: string; location_id?: string;
      reported_qty?: string; executed_on?: string; contractor_label?: string;
      note?: string; over_execution_reason?: string;
    };

    if (!p.project_id || !p.work_item_id || !p.location_id || !p.reported_qty) {
      throw new SyncRejection(
        'This entry is missing its work item, location or quantity. It has been ' +
          'kept so you can complete it.',
        { provided: Object.keys(p) },
      );
    }

    // The device may have gone offline BEFORE a grant was revoked. Re-check
    // against current permissions rather than trusting what the app believed
    // when the entry was captured.
    const perms = await this.permissions.compile(actor.orgId, actor.userId);
    if (!this.permissions.holdsOnProject(perms, 'field.progress.create', p.project_id)) {
      throw new SyncRejection(
        'You no longer have permission to record progress on that project. The ' +
          'entry has been kept — ask your administrator.',
      );
    }

    try {
      // The SAME code path as the online endpoint. Two implementations of
      // "record progress" would diverge within a month, and the divergence
      // would surface in whichever path is less tested.
      const row = await this.progress.recordInTrx(
        trx,
        { userId: actor.userId, orgId: actor.orgId, permissions: perms },
        p.project_id,
        {
          workItemId: p.work_item_id,
          locationId: p.location_id,
          reportedQty: p.reported_qty,
          executedOn: p.executed_on,
          contractorLabel: p.contractor_label,
          note: p.note,
          overExecutionReason: p.over_execution_reason,
          clientUuid: item.client_uuid,
          deviceClockSkewMs: item.clock_skew_ms,
        },
        perms.keys['field.progress.create']?.grantId,
        perms.keys['field.progress.create']?.responsibilityLabel,
      );
      return { serverId: row.id, version: row.version };
    } catch (err) {
      const msg = (err as Error).message;
      // Over-execution needs a reason the SERVER could not know at capture
      // time — the device had no idea how much others had recorded while it
      // was offline. Surface it so the supervisor can confirm and resubmit.
      if (/over_execution_reason/.test(msg)) {
        throw new SyncRejection(
          'While you were offline this work item passed its planned quantity at ' +
            'that location. Confirm the over-execution and resubmit.',
          { server_message: msg },
        );
      }
      if (/not found/i.test(msg)) {
        throw new SyncRejection(
          'The work item or location for this entry no longer exists on the ' +
            'project. The entry has been kept.',
        );
      }
      throw err;
    }
  }
}
