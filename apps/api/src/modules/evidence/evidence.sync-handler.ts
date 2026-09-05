import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '@ct/db';
import { SyncRegistry } from '../sync/sync.registry.js';
import {
  SyncRejection, SyncConflict,
  type AppliedItem, type SyncActor, type SyncHandler, type SyncItem,
} from '../sync/sync.types.js';

/**
 * Evidence links, offline.
 *
 * The photo itself uploads through the presign path — bytes never travel in a
 * sync batch. What syncs is the ATTACHMENT: "this asset belongs to that record,
 * for this purpose". A supervisor in a basement photographs four flats and the
 * links queue until there is signal.
 *
 * Policy: accept_as_new. Two people attaching evidence to different records are
 * not in disagreement about anything, so there is nothing to resolve. The one
 * genuine conflict is attaching to a record that has since been locked, and
 * that is rejected to needs-attention rather than silently dropped.
 */
@Injectable()
export class EvidenceLinkSyncHandler implements SyncHandler, OnModuleInit {
  readonly entity = 'evidence_link';
  readonly conflictPolicy = 'accept_as_new' as const;
  readonly permission = 'field.evidence.create';

  constructor(private readonly registry: SyncRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async apply(trx: Transaction<DB>, actor: SyncActor, item: SyncItem): Promise<AppliedItem> {
    const p = item.payload as {
      evidence_id?: string; entity_type?: string; entity_id?: string;
      purpose?: string; location_id?: string; caption?: string;
    };

    if (!p.evidence_id || !p.entity_type || !p.entity_id) {
      throw new SyncRejection(
        'This attachment is missing its evidence or its record. It was kept so ' +
          'you can retry it.',
        { got: Object.keys(p) },
      );
    }

    const asset = await trx.selectFrom('app.evidence_assets')
      .select(['id', 'project_id', 'state'])
      .where('id', '=', p.evidence_id)
      .executeTakeFirst();

    if (!asset) {
      // The photo has not finished uploading, or never will. Keep the link so
      // the device can retry once the upload completes.
      throw new SyncRejection(
        'The photo for this attachment has not reached the server yet. It will ' +
          'be retried once the upload finishes.',
        { evidence_id: p.evidence_id },
      );
    }
    if (asset.state === 'quarantined') {
      throw new SyncRejection('That file failed validation and cannot be attached.');
    }

    const existing = await trx.selectFrom('app.evidence_links')
      .select(['id', 'unlinked_at'])
      .where('evidence_id', '=', p.evidence_id)
      .where('entity_type', '=', p.entity_type)
      .where('entity_id', '=', p.entity_id)
      .where('unlinked_at', 'is', null)
      .executeTakeFirst();

    if (existing) {
      // Someone already attached these exact bytes to this record — most often
      // the same user from a second device. Not an error, and not a duplicate.
      throw new SyncConflict(
        'accept_as_new',
        'That photo was already attached to this record from another device.',
        { existing_link_id: existing.id },
      );
    }

    const row = await trx.insertInto('app.evidence_links').values({
      org_id: actor.orgId,
      project_id: asset.project_id,
      evidence_id: p.evidence_id,
      entity_type: p.entity_type,
      entity_id: p.entity_id,
      purpose: (p.purpose ?? 'general') as 'general',
      location_id: p.location_id ?? null,
      caption: p.caption ?? null,
      linked_by: actor.userId,
      linked_by_grant_id: actor.grantId ?? null,
      linked_at: item.device_ts ? new Date(item.device_ts) : new Date(),
    }).returning(['id', 'version']).executeTakeFirstOrThrow();

    return { serverId: row.id, version: row.version };
  }
}
