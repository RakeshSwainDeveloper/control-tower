import {
  Injectable, Inject, ConflictException, BadRequestException, GoneException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN, ENV_TOKEN } from '../../common/tokens.js';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../common/audit.service.js';
import { assertVisible } from '../access/scoped-query.js';
import { StorageService } from './storage.service.js';
import {
  assertCaptureAllowed, isEvidentiary, CLOCK_SKEW_FLAG_MS,
  type EvidenceKind, type EvidencePurpose, type CaptureMethod,
} from './evidence.policy.js';

export interface EvidenceActor {
  userId: string;
  orgId: string;
  grantId?: string | undefined;
  responsibility?: string | undefined;
}

export interface PresignInput {
  kind: EvidenceKind; purpose: EvidencePurpose; mime: string; sizeBytes: number;
  contentHash: string; captureMethod: CaptureMethod; capturedAtDevice: Date;
  originalFileTimestamp?: Date; projectId?: string; locationId?: string;
  gps?: { lat: number; lng: number; accuracyM?: number };
  gpsUnavailableReason?: string; durationMs?: number;
  width?: number; height?: number; deviceModel?: string; appVersion?: string;
  clientUuid?: string;
  link?: { entityType: string; entityId: string; caption?: string };
}

@Injectable()
export class EvidenceService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Kysely<DB>,
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Step 1 of the two-phase upload: authorise, then hand out a URL.
   *
   * Validation happens BEFORE the bytes move. On one bar of 3G, rejecting a
   * capture after a 40-second upload is the difference between a refusal and a
   * lost afternoon.
   */
  async presign(actor: EvidenceActor, input: PresignInput) {
    assertCaptureAllowed(
      {
        kind: input.kind, purpose: input.purpose, mime: input.mime,
        sizeBytes: input.sizeBytes, captureMethod: input.captureMethod,
        capturedAtDevice: input.capturedAtDevice,
        originalFileTimestamp: input.originalFileTimestamp,
        gps: input.gps, gpsUnavailableReason: input.gpsUnavailableReason,
        durationMs: input.durationMs,
      },
      this.env,
    );

    const hashBuf = Buffer.from(input.contentHash, 'hex');
    const skewMs = Date.now() - input.capturedAtDevice.getTime();

    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      // ── Dedupe (FR-173) ──────────────────────────────────────────
      const existing = await trx
        .selectFrom('app.evidence_assets')
        .select(['id', 'storage_key', 'state', 'captured_at_server', 'captured_by'])
        .where('content_hash', '=', hashBuf)
        .orderBy('captured_at_server', 'desc')
        .executeTakeFirst();

      if (existing) {
        if (input.link) {
          // Same bytes on the SAME record is a duplicate and is refused.
          const already = await trx
            .selectFrom('app.evidence_links').select('id')
            .where('evidence_id', '=', existing.id)
            .where('entity_type', '=', input.link.entityType)
            .where('entity_id', '=', input.link.entityId)
            .where('unlinked_at', 'is', null)
            .executeTakeFirst();
          if (already) {
            throw new ConflictException(
              'That exact photo is already attached to this record.',
            );
          }
        }
        // Same bytes on a DIFFERENT record is legitimate reuse: store once,
        // link twice, and make the cross-link visible.
        return {
          deduplicated: true,
          evidence_id: existing.id,
          state: existing.state,
          message: 'These bytes are already stored; no upload needed.',
          upload: null,
        };
      }

      const id = (await sql<{ id: string }>`SELECT app.uuid_v7() AS id`.execute(trx))
        .rows[0]!.id;
      const key = this.storage.buildKey(actor.orgId, id, input.mime);

      await trx.insertInto('app.evidence_assets').values({
        id,
        org_id: actor.orgId,
        project_id: input.projectId ?? null,
        kind: input.kind,
        storage_key: key,
        mime_type: input.mime,
        size_bytes: String(input.sizeBytes),
        content_hash: hashBuf,
        width: input.width ?? null,
        height: input.height ?? null,
        duration_ms: input.durationMs ?? null,
        captured_at_device: input.capturedAtDevice,
        captured_by: actor.userId,
        captured_by_grant_id: actor.grantId ?? null,
        responsibility_label: actor.responsibility ?? null,
        capture_method: input.captureMethod,
        gps_lat: input.gps ? String(input.gps.lat) : null,
        gps_lng: input.gps ? String(input.gps.lng) : null,
        gps_accuracy_m: input.gps?.accuracyM != null ? String(input.gps.accuracyM) : null,
        gps_unavailable_reason: input.gpsUnavailableReason ?? null,
        device_model: input.deviceModel ?? null,
        app_version: input.appVersion ?? null,
        clock_skew_ms: skewMs,
        original_file_timestamp: input.originalFileTimestamp ?? null,
        state: 'pending_upload',
        client_uuid: input.clientUuid ?? null,
        is_offline_origin: !!input.clientUuid,
      }).execute();

        /**
         * Attach it now, at capture, not at completion.
         *
         * `presignSchema` has always documented `link` as "link on completion,
         * so capture and attach are one round trip" — and nothing ever created
         * the row. The field was accepted, used only for the duplicate check,
         * then silently discarded, so a client that trusted it ended up with an
         * unattached photograph and no error to act on.
         *
         * Written here rather than in complete() because the intent exists at
         * capture and there is nowhere durable to keep it otherwise. A link
         * whose upload never lands points at an asset still in
         * `pending_upload`, which is why every guard that requires evidence
         * must check the ASSET STATE, not merely that a link exists.
         */
        if (input.link) {
          await trx.insertInto('app.evidence_links').values({
            org_id: actor.orgId,
            project_id: input.projectId ?? null,
            evidence_id: id,
            entity_type: input.link.entityType,
            entity_id: input.link.entityId,
            purpose: input.purpose,
            location_id: input.locationId ?? null,
            caption: input.link.caption ?? null,
            linked_by: actor.userId,
            linked_by_grant_id: actor.grantId ?? null,
          }).onConflict((oc) => oc.doNothing()).execute();
        }


      const upload = await this.storage.presignUpload(key, input.mime, input.sizeBytes);

      return {
        deduplicated: false,
        evidence_id: id,
        state: 'pending_upload' as const,
        clock_skew_ms: skewMs,
        clock_skew_flagged: Math.abs(skewMs) > CLOCK_SKEW_FLAG_MS,
        upload,
      };
    });
  }

  /**
   * Step 2: the client confirms the bytes landed.
   *
   * The claimed size is checked against what the store actually received. A
   * client that says "5 MB" and uploads 12 bytes does not get a ready asset.
   */
  async complete(
    actor: EvidenceActor, evidenceId: string,
    body: { uploadId?: string; parts?: Array<{ part_number: number; etag: string }> },
  ) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const asset = assertVisible(
        await trx.selectFrom('app.evidence_assets').selectAll()
          .where('id', '=', evidenceId).executeTakeFirst(),
        'Evidence',
      );
      if (asset.state !== 'pending_upload') {
        // Idempotent: a retried completion is not an error.
        return { evidence_id: evidenceId, state: asset.state, already_complete: true };
      }

      if (body.uploadId && body.parts?.length) {
        await this.storage.completeMultipart(asset.storage_key, body.uploadId, body.parts);
      }

      const head = await this.storage.head(asset.storage_key);
      if (!head) {
        throw new BadRequestException(
          'No object found at that key. The upload did not complete.',
        );
      }
      if (head.size !== Number(asset.size_bytes)) {
        // Do NOT mark it ready: the row stays visible with its reason so the
        // failure is diagnosable rather than a silent gap in the evidence.
        await trx.updateTable('app.evidence_assets')
          .set({
            state: 'failed',
            state_reason: `Declared ${asset.size_bytes} bytes, received ${head.size}`,
          })
          .where('id', '=', evidenceId).execute();
        throw new BadRequestException(
          `Upload size mismatch: declared ${asset.size_bytes} bytes, ` +
            `received ${head.size}.`,
        );
      }

      await trx.updateTable('app.evidence_assets')
        .set({ state: 'uploaded', uploaded_at: new Date() })
        .where('id', '=', evidenceId).execute();

      await this.audit.write(trx, actor.orgId, {
        entityType: 'evidence', entityId: evidenceId, action: 'create',
        projectId: asset.project_id,
        context: {
          kind: asset.kind, size_bytes: asset.size_bytes,
          capture_method: asset.capture_method,
          gps: asset.gps_lat ? 'recorded' : (asset.gps_unavailable_reason ?? 'absent'),
          clock_skew_ms: asset.clock_skew_ms,
        },
      });

      return { evidence_id: evidenceId, state: 'uploaded' as const, already_complete: false };
    });
  }

  async link(actor: EvidenceActor, evidenceId: string, input: {
    entityType: string; entityId: string; purpose: EvidencePurpose;
    locationId?: string; caption?: string; sortOrder: number;
  }) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const asset = assertVisible(
        await trx.selectFrom('app.evidence_assets')
          .select(['id', 'project_id', 'state', 'content_hash'])
          .where('id', '=', evidenceId).executeTakeFirst(),
        'Evidence',
      );
      if (asset.state === 'pending_upload') {
        throw new BadRequestException('That evidence has not finished uploading yet');
      }
      if (asset.state === 'quarantined') {
        throw new GoneException('That file failed validation and cannot be attached');
      }

      const row = await trx.insertInto('app.evidence_links').values({
        org_id: actor.orgId,
        project_id: asset.project_id,
        evidence_id: evidenceId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        purpose: input.purpose,
        location_id: input.locationId ?? null,
        caption: input.caption ?? null,
        sort_order: input.sortOrder,
        linked_by: actor.userId,
        linked_by_grant_id: actor.grantId ?? null,
      })
        .onConflict((oc) => oc.doNothing())
        .returningAll().executeTakeFirst();

      if (!row) throw new ConflictException('That evidence is already attached to this record');

      await this.audit.write(trx, actor.orgId, {
        entityType: input.entityType, entityId: input.entityId, action: 'update',
        projectId: asset.project_id,
        context: { evidence_linked: evidenceId, purpose: input.purpose },
      });
      return row;
    });
  }

  /**
   * Soft unlink (FR-172/183).
   *
   * Evidence is never versioned and never replaced. If a photo was wrong, a new
   * one is added and this one is detached WITH A REASON — the bytes stay, and
   * the timeline shows both the attachment and its removal.
   */
  async unlink(actor: EvidenceActor, linkId: string, reason: string) {
    return withTenant(this.db, { orgId: actor.orgId, userId: actor.userId }, async (trx) => {
      const link = assertVisible(
        await trx.selectFrom('app.evidence_links').selectAll()
          .where('id', '=', linkId).where('unlinked_at', 'is', null).executeTakeFirst(),
        'Evidence link',
      );

      const after = await trx.updateTable('app.evidence_links')
        .set({ unlinked_at: new Date(), unlinked_by: actor.userId, unlink_reason: reason })
        .where('id', '=', linkId).returningAll().executeTakeFirstOrThrow();

      await this.audit.write(trx, actor.orgId, {
        entityType: link.entity_type, entityId: link.entity_id, action: 'update',
        projectId: link.project_id,
        changes: [{ field: 'evidence', old: link.evidence_id, new: null }],
        context: { evidence_unlinked: link.evidence_id, reason },
      });
      return after;
    });
  }

  /** FR-180: a short-lived signed URL, generated per request. */
  async getSignedUrl(actor: EvidenceActor, evidenceId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const asset = assertVisible(
        await trx.selectFrom('app.evidence_assets').selectAll()
          .where('id', '=', evidenceId).executeTakeFirst(),
        'Evidence',
      );
      if (asset.state === 'pending_upload') {
        throw new BadRequestException('That evidence has not finished uploading yet');
      }

      const [url, thumb] = await Promise.all([
        this.storage.presignDownload(asset.storage_key),
        asset.thumbnail_key ? this.storage.presignDownload(asset.thumbnail_key) : null,
      ]);

      return {
        id: asset.id,
        kind: asset.kind,
        mime_type: asset.mime_type,
        size_bytes: Number(asset.size_bytes),
        state: asset.state,
        url,
        thumbnail_url: thumb,
        expires_in: this.env.S3_SIGNED_URL_TTL_SECONDS,
        // The provenance a verifier needs to judge the evidence.
        captured: {
          at_device: asset.captured_at_device,
          at_server: asset.captured_at_server,
          by: asset.captured_by,
          as: asset.responsibility_label,
          method: asset.capture_method,
          gps: asset.gps_lat
            ? { lat: Number(asset.gps_lat), lng: Number(asset.gps_lng),
                accuracy_m: asset.gps_accuracy_m ? Number(asset.gps_accuracy_m) : null }
            : null,
          gps_unavailable_reason: asset.gps_unavailable_reason,
          device_model: asset.device_model,
          app_version: asset.app_version,
          clock_skew_ms: asset.clock_skew_ms,
          clock_skew_flagged: Math.abs(asset.clock_skew_ms ?? 0) > CLOCK_SKEW_FLAG_MS,
        },
      };
    });
  }

  async listForEntity(actor: EvidenceActor, entityType: string, entityId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, (trx) =>
      trx.selectFrom('app.evidence_links as l')
        .innerJoin('app.evidence_assets as a', 'a.id', 'l.evidence_id')
        .select(['l.id as link_id', 'l.purpose', 'l.caption', 'l.sort_order',
                 'l.linked_at', 'l.linked_by', 'l.location_id',
                 'a.id as evidence_id', 'a.kind', 'a.mime_type', 'a.state',
                 'a.captured_at_device', 'a.captured_by', 'a.responsibility_label',
                 'a.capture_method', 'a.gps_lat', 'a.gps_lng',
                 'a.gps_unavailable_reason', 'a.clock_skew_ms'])
        .where('l.entity_type', '=', entityType)
        .where('l.entity_id', '=', entityId)
        .where('l.unlinked_at', 'is', null)
        .orderBy('l.sort_order')
        .orderBy('a.captured_at_device')
        .execute(),
    );
  }

  /** Evidence gallery, permission- and project-scoped. */
  async list(actor: EvidenceActor, opts: {
    cursor?: string; limit: number; projectId?: string;
    entityType?: string; entityId?: string; purpose?: string; locationId?: string;
  }) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let qb = trx.selectFrom('app.evidence_links as l')
        .innerJoin('app.evidence_assets as a', 'a.id', 'l.evidence_id')
        .select(['l.id as link_id', 'l.entity_type', 'l.entity_id', 'l.purpose',
                 'l.linked_at', 'a.id as evidence_id', 'a.kind', 'a.state',
                 'a.captured_at_device', 'a.captured_by', 'a.responsibility_label'])
        .where('l.unlinked_at', 'is', null)
        .orderBy('l.id', 'desc')
        .limit(opts.limit + 1);

      if (opts.projectId) qb = qb.where('l.project_id', '=', opts.projectId);
      if (opts.entityType) qb = qb.where('l.entity_type', '=', opts.entityType);
      if (opts.entityId) qb = qb.where('l.entity_id', '=', opts.entityId);
      if (opts.purpose) qb = qb.where('l.purpose', '=', opts.purpose as 'general');
      if (opts.locationId) qb = qb.where('l.location_id', '=', opts.locationId);
      if (opts.cursor) qb = qb.where('l.id', '<', opts.cursor);

      const rows = await qb.execute();
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return {
        data,
        next_cursor: hasMore ? data[data.length - 1]!.link_id : null,
        has_more: hasMore,
      };
    });
  }

  /** Marks an asset ready. Called by the worker after thumbnailing. */
  async markReady(orgId: string, evidenceId: string, thumbnailKey: string | null) {
    await withTenant(this.db, { orgId }, (trx) =>
      trx.updateTable('app.evidence_assets')
        .set({ state: 'ready', thumbnail_key: thumbnailKey })
        .where('id', '=', evidenceId).execute(),
    );
  }
}
