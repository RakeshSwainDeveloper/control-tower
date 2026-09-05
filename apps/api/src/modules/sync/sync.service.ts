import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN, LOGGER_TOKEN } from '../../common/tokens.js';
import { AuditService } from '../../common/audit.service.js';
import { SyncRegistry } from './sync.registry.js';
import {
  SyncConflict, SyncRejection,
  type SyncActor, type SyncItem, type SyncResult,
} from './sync.types.js';

const MAX_BATCH = 200;
/** Beyond this the device's clock is wrong; recorded, never silently trusted. */
const CLOCK_SKEW_FLAG_MS = 5 * 60 * 1000;

@Injectable()
export class SyncService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(LOGGER_TOKEN) private readonly log: Logger,
    private readonly registry: SyncRegistry,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ingests one outbox batch.
   *
   * Three properties the whole offline story rests on:
   *
   *  1. EVERY ITEM IS INDEPENDENT. One bad item never fails the batch — a
   *     device with one malformed record must still deliver the other 49.
   *  2. REPLAY IS FREE. client_uuid is the idempotency key; a replayed item
   *     returns its ORIGINAL result instead of doing the work twice.
   *  3. NOTHING IS EVER DISCARDED. A rejection keeps the payload and surfaces
   *     it in needs-attention, so the user corrects rather than re-enters.
   */
  async ingest(actor: SyncActor, items: SyncItem[]): Promise<{ results: SyncResult[] }> {
    if (items.length === 0) return { results: [] };
    if (items.length > MAX_BATCH) {
      throw new BadRequestException(
        `Batch of ${items.length} exceeds the limit of ${MAX_BATCH}. Split it.`,
      );
    }

    const results: SyncResult[] = [];
    for (const item of items) {
      results.push(await this.ingestOne(actor, item));
    }
    return { results };
  }

  private async ingestOne(actor: SyncActor, item: SyncItem): Promise<SyncResult> {
    // ── Replay check, outside the work transaction ──────────────────
    const prior = await this.findPrior(actor.orgId, item.client_uuid);
    if (prior) {
      return {
        client_uuid: item.client_uuid,
        status: prior.status,
        server_id: prior.server_entity_id,
        server_number: prior.server_number,
        ...(prior.reason ? { reason: prior.reason } : {}),
        ...((prior.result as Record<string, unknown>)?.['conflict']
          ? { conflict: (prior.result as Record<string, never>)['conflict'] }
          : {}),
      };
    }

    const handler = this.registry.get(item.entity);
    if (!handler) {
      // An unknown entity is a client/server version mismatch, not a user
      // error — but the payload is still kept so nothing is lost on upgrade.
      return this.record(actor, item, {
        status: 'rejected',
        reason: `This version of the server does not accept '${item.entity}'. ` +
          'Update the app; your entry has been kept.',
        needsAttention: true,
      });
    }

    const skew = item.clock_skew_ms ?? 0;
    if (Math.abs(skew) > CLOCK_SKEW_FLAG_MS) {
      this.log.warn(
        { device: actor.deviceId, skewMs: skew, entity: item.entity },
        'device clock skew beyond threshold',
      );
    }

    try {
      const applied = await withTenant(
        this.db,
        { orgId: actor.orgId, userId: actor.userId, grantId: actor.grantId },
        (trx) => handler.apply(trx, actor, item),
      );

      return this.record(actor, item, {
        status: applied.conflict ? 'conflict' : 'accepted',
        serverId: applied.serverId,
        serverNumber: applied.serverNumber ?? null,
        version: applied.version ?? null,
        conflict: applied.conflict,
        // A conflict that kept both records is resolved, not outstanding: the
        // PM reviews it in the conflict list, the device does not retry it.
        needsAttention: false,
      });
    } catch (err) {
      if (err instanceof SyncConflict) {
        return this.record(actor, item, {
          status: 'conflict',
          reason: err.userMessage,
          conflict: { policy: err.policy, keptBoth: false, detail: err.userMessage },
          needsAttention: err.policy === 'reject_to_attention',
        });
      }
      if (err instanceof SyncRejection) {
        return this.record(actor, item, {
          status: 'rejected', reason: err.userMessage, needsAttention: true,
        });
      }
      // An unexpected failure must not swallow the user's work either.
      this.log.error(
        { err, entity: item.entity, clientUuid: item.client_uuid },
        'sync item failed unexpectedly',
      );
      return this.record(actor, item, {
        status: 'rejected',
        reason: 'The server could not process this entry. It has been kept so ' +
          'you can retry it.',
        needsAttention: true,
      });
    }
  }

  /**
   * Writes the ledger row and returns the client's result.
   *
   * Deliberately a SEPARATE transaction from the work: if the work committed
   * and the ledger did not, a replay would duplicate it. Committing the ledger
   * after the work means a crash in between yields a retry that the unique
   * index then catches — an extra ledger row is harmless; a duplicate progress
   * entry is not.
   */
  private async record(
    actor: SyncActor, item: SyncItem,
    outcome: {
      status: 'accepted' | 'conflict' | 'rejected';
      serverId?: string; serverNumber?: string | null; version?: number | null;
      reason?: string; needsAttention: boolean;
      conflict?: { policy: string; keptBoth: boolean; otherId?: string | null; detail?: string };
    },
  ): Promise<SyncResult> {
    const result: Record<string, unknown> = {};
    if (outcome.conflict) {
      result['conflict'] = {
        policy: outcome.conflict.policy,
        kept_both: outcome.conflict.keptBoth,
        other_id: outcome.conflict.otherId ?? null,
        detail: outcome.conflict.detail ?? null,
      };
    }

    await withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      await trx.insertInto('app.sync_operations').values({
        org_id: actor.orgId,
        user_id: actor.userId,
        device_id: actor.deviceId ?? null,
        client_uuid: item.client_uuid,
        entity_type: item.entity,
        operation: item.op,
        payload: JSON.stringify(item.payload),
        device_ts: item.device_ts ? new Date(item.device_ts) : null,
        clock_skew_ms: item.clock_skew_ms ?? null,
        base_version: item.base_version ?? null,
        processed_at: new Date(),
        status: outcome.status,
        server_entity_id: outcome.serverId ?? null,
        server_number: outcome.serverNumber ?? null,
        result: JSON.stringify(result),
        reason: outcome.reason ?? null,
        needs_attention: outcome.needsAttention,
      })
        // A concurrent duplicate submission of the same client_uuid loses the
        // race here rather than duplicating the entity.
        .onConflict((oc) => oc.doNothing())
        .execute();

      if (outcome.conflict) {
        await trx.insertInto('app.sync_conflicts').values({
          org_id: actor.orgId,
          sync_client_uuid: item.client_uuid,
          entity_type: item.entity,
          entity_id: outcome.serverId ?? null,
          policy_applied: outcome.conflict.policy as 'accept_as_new',
          kept_both: outcome.conflict.keptBoth,
          other_entity_id: outcome.conflict.otherId ?? null,
          detail: JSON.stringify({ message: outcome.conflict.detail ?? null }),
          flagged_for_user_id: actor.userId,
        }).execute();
      }
    });

    return {
      client_uuid: item.client_uuid,
      status: outcome.status,
      server_id: outcome.serverId ?? null,
      server_number: outcome.serverNumber ?? null,
      version: outcome.version ?? null,
      ...(outcome.conflict
        ? {
            conflict: {
              policy: outcome.conflict.policy as 'accept_as_new',
              kept_both: outcome.conflict.keptBoth,
              other_id: outcome.conflict.otherId ?? null,
              detail: outcome.conflict.detail,
            },
          }
        : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }

  private async findPrior(orgId: string, clientUuid: string) {
    return withTenant(this.db, { orgId }, (trx) =>
      trx.selectFrom('app.sync_operations')
        .select(['status', 'server_entity_id', 'server_number', 'reason', 'result'])
        .where('client_uuid', '=', clientUuid)
        .executeTakeFirst(),
    );
  }

  /**
   * The needs-attention queue (FR-491).
   *
   * Items rejected on sync are NEVER silently dropped. They surface here with
   * the server's reason and the original payload intact, so the user corrects
   * and resubmits rather than re-entering from memory.
   */
  async needsAttention(actor: SyncActor, limit = 100) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const rows = await trx.selectFrom('app.sync_operations')
        .select(['client_uuid', 'entity_type', 'operation', 'payload',
                 'reason', 'status', 'received_at', 'device_id'])
        .where('user_id', '=', actor.userId)
        .where('needs_attention', '=', true)
        .where('resolved_at', 'is', null)
        .orderBy('received_at', 'desc')
        .limit(limit)
        .execute();
      return {
        count: rows.length,
        items: rows.map((r) => ({
          client_uuid: r.client_uuid,
          entity: r.entity_type,
          op: r.operation,
          reason: r.reason,
          status: r.status,
          received_at: r.received_at,
          device_id: r.device_id,
          // Returned so the client can pre-fill the correction form.
          payload: r.payload,
        })),
      };
    });
  }

  async resolveAttention(actor: SyncActor, clientUuid: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const res = await trx.updateTable('app.sync_operations')
        .set({ resolved_at: new Date(), resolved_by: actor.userId, needs_attention: false })
        .where('client_uuid', '=', clientUuid)
        .where('user_id', '=', actor.userId)
        .where('resolved_at', 'is', null)
        .executeTakeFirst();
      return { resolved: Number(res.numUpdatedRows) > 0 };
    });
  }

  /**
   * What the device should hold locally (FR-486).
   *
   * A phone does not carry the whole tenant: active projects, a 90-day window,
   * and only the entities this build can queue.
   */
  async manifest(actor: SyncActor, projectId?: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const projects = await trx.selectFrom('app.projects')
        .select(['id', 'code', 'name', 'state_class'])
        .where('state_class', 'in', ['draft', 'in_progress'])
        .$if(!!projectId, (q) => q.where('id', '=', projectId!))
        .execute();

      const pending = await trx.selectFrom('app.sync_operations')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', actor.userId)
        .where('needs_attention', '=', true)
        .where('resolved_at', 'is', null)
        .executeTakeFirst();

      return {
        offline_entities: this.registry.entities(),
        window_days: 90,
        max_batch: MAX_BATCH,
        projects,
        needs_attention: Number(pending?.n ?? 0),
        server_time: new Date().toISOString(),
      };
    });
  }

  /** Delta pull by keyset cursor, so a device never re-downloads the world. */
  async pull(actor: SyncActor, entity: string, cursor: string | undefined, limit: number) {
    if (!this.registry.get(entity)) {
      throw new BadRequestException(`'${entity}' is not an offline entity in this build`);
    }
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      if (entity !== 'evidence_link') return { entity, data: [], next_cursor: null, has_more: false };

      let qb = trx.selectFrom('app.evidence_links')
        .select(['id', 'entity_type', 'entity_id', 'evidence_id', 'purpose',
                 'location_id', 'linked_at', 'unlinked_at'])
        .orderBy('id', 'asc')
        .limit(limit + 1);
      if (cursor) qb = qb.where('id', '>', cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const next = hasMore ? data[data.length - 1]!.id : null;

      if (next && actor.deviceId) {
        await trx.insertInto('app.sync_cursors').values({
          org_id: actor.orgId, user_id: actor.userId,
          device_id: actor.deviceId, entity_type: entity, cursor: next,
        }).onConflict((oc) => oc
          .columns(['org_id', 'user_id', 'device_id', 'entity_type'])
          .doUpdateSet({ cursor: next, updated_at: new Date() })).execute();
      }
      return { entity, data, next_cursor: next, has_more: hasMore };
    });
  }

  async conflicts(actor: SyncActor, projectId?: string) {
    return withTenant(this.db, { orgId: actor.orgId }, (trx) =>
      trx.selectFrom('app.sync_conflicts')
        .selectAll()
        .$if(!!projectId, (q) => q.where('project_id', '=', projectId!))
        .where('reviewed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
    );
  }
}
