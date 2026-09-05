import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB } from '@ct/db';
import { SyncRegistry } from '../sync/sync.registry.js';
import {
  SyncRejection,
  type AppliedItem, type SyncActor, type SyncHandler, type SyncItem,
} from '../sync/sync.types.js';
import { IssuesService } from './issues.service.js';
import { PermissionService } from '../access/permission.service.js';

/**
 * Issues, offline.
 *
 * Policy: accept_as_new. Two people photographing the same crack from two
 * phones have genuinely both reported it, and the site would rather see one
 * duplicate than lose a defect because the server guessed they were the same
 * problem. Duplicates are merged by a human later; a swallowed report never
 * comes back.
 *
 * Only `create` is offline-capable. Resolve, verify and close all depend on
 * server state the device cannot see — an SoD check, an evidence link, an
 * approval outcome — and a device deciding those from stale data is exactly
 * how a defect gets closed by the person who caused it.
 */
@Injectable()
export class IssuesSyncHandler implements SyncHandler, OnModuleInit {
  readonly entity = 'issue';
  readonly conflictPolicy = 'accept_as_new' as const;
  readonly permission = 'issue.issue.create';

  constructor(
    private readonly registry: SyncRegistry,
    private readonly issues: IssuesService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    if (item.op !== 'create') {
      throw new SyncRejection(
        'Only new issues can be raised offline. Resolving, verifying and closing ' +
          'need the current state of the issue, so they are done online.',
        { op: item.op },
      );
    }

    const p = item.payload as {
      project_id?: string; title?: string; severity?: string;
      category_code?: string; description?: string;
      location_id?: string; work_item_id?: string; contractor_label?: string;
      assignee_user_id?: string; due_date?: string;
    };

    if (!p.project_id || !p.title?.trim()) {
      throw new SyncRejection('This issue is missing its project or title.', { payload: p });
    }

    const perms = await this.permissions.compile(actor.orgId, actor.userId);
    if (!this.permissions.holdsOnProject(perms, 'issue.issue.create', p.project_id)) {
      throw new SyncRejection(
        'You no longer have permission to raise issues on this project. It may have ' +
          'changed while your phone was offline.',
        { project_id: p.project_id },
      );
    }

    const grant = perms.keys['issue.issue.create'];
    const row = await this.issues.raiseInTrx(
      trx,
      { userId: actor.userId, orgId: actor.orgId, permissions: perms },
      p.project_id,
      {
        title: p.title,
        severity: p.severity ?? 'medium',
        categoryCode: p.category_code,
        description: p.description,
        locationId: p.location_id,
        workItemId: p.work_item_id,
        contractorLabel: p.contractor_label,
        assigneeUserId: p.assignee_user_id,
        dueDate: p.due_date,
        clientUuid: item.client_uuid,
      },
      grant?.grantId,
      grant?.responsibilityLabel,
    );

    return { serverId: row.id, serverNumber: row.issue_number, version: row.version };
  }
}
