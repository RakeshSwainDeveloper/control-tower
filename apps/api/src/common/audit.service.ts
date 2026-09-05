import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DB, AuditAction, AuditSource } from '@ct/db';
import { currentContext } from './correlation.js';

export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: AuditAction;
  projectId?: string | null;
  /** [{field, old, new}] — what actually changed, not the whole row. */
  changes?: Array<{ field: string; old: unknown; new: unknown }>;
  context?: Record<string, unknown>;
  /** Overrides the ambient request context, e.g. for system jobs. */
  actorUserId?: string | null;
  actorGrantId?: string | null;
  responsibilityLabel?: string | null;
  source?: AuditSource;
}

/**
 * Audit writes.
 *
 * The single rule that matters: `write()` takes a TRANSACTION, never a database
 * handle. An audit row is committed with the change it describes or not at all
 * (FR-508). A change that succeeds while its audit entry fails is not
 * acceptable, and the only way to guarantee that is to make the transaction a
 * required argument rather than an optional convenience.
 *
 * The table holds INSERT + SELECT grants only, so there is deliberately no
 * update() or delete() on this service — there is nothing they could call.
 */
@Injectable()
export class AuditService {
  async write(trx: Transaction<DB>, orgId: string, entry: AuditEntry): Promise<void> {
    const ctx = currentContext();
    await trx
      .insertInto('app.audit_log')
      .values({
        org_id: orgId,
        project_id: entry.projectId ?? null,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        action: entry.action,
        actor_user_id: entry.actorUserId ?? ctx?.userId ?? null,
        actor_grant_id: entry.actorGrantId ?? ctx?.grantId ?? null,
        // FR-030: which responsibility was exercised, not merely who acted.
        responsibility_label: entry.responsibilityLabel ?? ctx?.responsibilityLabel ?? null,
        source: entry.source ?? ctx?.source ?? 'api',
        device_id: ctx?.deviceId ?? null,
        app_version: ctx?.appVersion ?? null,
        ip: ctx?.ip ?? null,
        correlation_id: ctx?.correlationId ?? null,
        changes: JSON.stringify(entry.changes ?? []),
        context: JSON.stringify(entry.context ?? {}),
      })
      .execute();
  }

  /**
   * Diffs two versions of a row into audit `changes`, skipping noise.
   * Secrets never reach the audit trail — only the fact that they changed.
   */
  diff(
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    opts: { ignore?: string[]; redact?: string[] } = {},
  ): Array<{ field: string; old: unknown; new: unknown }> {
    const ignore = new Set([
      'updated_at', 'created_at', 'version', ...(opts.ignore ?? []),
    ]);
    const redact = new Set([
      'password_hash', 'refresh_token_hash', 'token_hash', 'code_hash', 'mfa_secret',
      ...(opts.redact ?? []),
    ]);
    const out: Array<{ field: string; old: unknown; new: unknown }> = [];
    for (const [field, next] of Object.entries(after)) {
      if (ignore.has(field)) continue;
      const prev = before?.[field];
      if (JSON.stringify(prev) === JSON.stringify(next)) continue;
      out.push(
        redact.has(field)
          ? { field, old: prev == null ? null : '[REDACTED]', new: '[REDACTED]' }
          : { field, old: prev ?? null, new: next },
      );
    }
    return out;
  }
}
