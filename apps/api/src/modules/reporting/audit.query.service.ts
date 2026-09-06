import { Injectable, Inject } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';
import type { Actor } from './dashboard.service.js';

/**
 * Reading the audit trail.
 *
 * Two shapes, because there are two questions. "Show me everything that
 * happened" is a filtered log; "what happened to THIS record" is a timeline
 * a person can read without knowing the schema. The second is the one that
 * settles arguments, so it renders changes as sentences rather than JSON.
 *
 * Read-only by construction: `ct_app` holds INSERT and SELECT on `audit_log`
 * and nothing else, so there is no update path to write even by mistake.
 */
export interface AuditFilter {
  projectId?: string; entityType?: string; entityId?: string;
  actorUserId?: string; action?: string;
  from?: string; to?: string;
  cursor?: string; limit: number;
}

@Injectable()
export class AuditQueryService {
  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  async list(actor: Actor, f: AuditFilter) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      let q = trx.selectFrom('app.audit_log as a')
        .leftJoin('app.users as u', 'u.id', 'a.actor_user_id')
        .leftJoin('app.projects as p', 'p.id', 'a.project_id')
        .select(['a.id', 'a.occurred_at', 'a.entity_type', 'a.entity_id', 'a.action',
                 'a.actor_user_id', 'a.responsibility_label', 'a.source',
                 'a.changes', 'a.context', 'a.correlation_id',
                 'u.name as actor_name', 'p.code as project_code'])
        // occurred_at DESC then id keeps the order stable across pages even
        // when two rows share a millisecond.
        .orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc')
        .limit(f.limit + 1);

      if (f.projectId) q = q.where('a.project_id', '=', f.projectId);
      if (f.entityType) q = q.where('a.entity_type', '=', f.entityType);
      if (f.entityId) q = q.where('a.entity_id', '=', f.entityId);
      if (f.actorUserId) q = q.where('a.actor_user_id', '=', f.actorUserId);
      if (f.action) q = q.where('a.action', '=', f.action as 'create');
      if (f.from) q = q.where('a.occurred_at', '>=', new Date(f.from));
      if (f.to) q = q.where('a.occurred_at', '<=', new Date(f.to));
      if (f.cursor) q = q.where('a.id', '<', f.cursor);

      const rows = await q.execute();
      const hasMore = rows.length > f.limit;
      const data = hasMore ? rows.slice(0, f.limit) : rows;
      return {
        data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore,
      };
    });
  }

  /**
   * The per-record timeline, in words.
   *
   * `changes` is stored as `[{field, old, new}]`. A project manager settling a
   * dispute should read "Anita changed the quantity from 12 to 9, as Site
   * Engineer" — not a JSON blob they have to decode. The rendering happens
   * here so every client says it the same way.
   */
  async timeline(actor: Actor, entityType: string, entityId: string) {
    return withTenant(this.db, { orgId: actor.orgId }, async (trx) => {
      const rows = await trx.selectFrom('app.audit_log as a')
        .leftJoin('app.users as u', 'u.id', 'a.actor_user_id')
        .select(['a.id', 'a.occurred_at', 'a.action', 'a.changes', 'a.context',
                 'a.responsibility_label', 'a.source', 'u.name as actor_name'])
        .where('a.entity_type', '=', entityType)
        .where('a.entity_id', '=', entityId)
        .orderBy('a.occurred_at', 'asc')
        .execute();

      return {
        entity_type: entityType,
        entity_id: entityId,
        as_of: new Date().toISOString(),
        definition:
          'Every recorded change to this record, in the order it happened, ' +
          'with who made it and the responsibility they held at the time.',
        data: rows.map((r) => ({
          id: r.id,
          at: r.occurred_at,
          actor: r.actor_name,
          responsibility: r.responsibility_label,
          action: r.action,
          source: r.source,
          sentence: sentence(r.action, r.actor_name, r.responsibility_label,
                             r.changes as ChangeSet, r.context as Record<string, unknown> | null),
          changes: r.changes,
        })),
      };
    });
  }

  /** CSV of the filtered log, honouring the same filters as the list. */
  async csv(actor: Actor, f: AuditFilter): Promise<string> {
    const { data } = await this.list(actor, { ...f, limit: 5000 });
    const head = ['occurred_at', 'entity_type', 'entity_id', 'action',
                  'actor', 'responsibility', 'project', 'source', 'changes'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(',')];
    for (const r of data) {
      lines.push([
        new Date(r.occurred_at).toISOString(), r.entity_type, r.entity_id, r.action,
        r.actor_name ?? '', r.responsibility_label ?? '', r.project_code ?? '',
        r.source, summarise(r.changes as ChangeSet),
      ].map(esc).join(','));
    }
    return lines.join('\n');
  }
}

type ChangeSet = { field: string; old: unknown; new: unknown }[] | null;

const VERB: Record<string, string> = {
  create: 'created it', update: 'changed it', transition: 'moved it',
  approve: 'approved it', reject: 'rejected it', verify: 'verified it',
  delete: 'deleted it', archive: 'archived it', export: 'exported it',
  import: 'imported it', comment: 'commented', login: 'signed in',
  config_change: 'changed the configuration', impersonation: 'impersonated a user',
};

function summarise(changes: ChangeSet): string {
  if (!Array.isArray(changes) || changes.length === 0) return '';
  return changes
    .map((c) => `${c.field}: ${fmt(c.old)} → ${fmt(c.new)}`)
    .join('; ');
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function sentence(
  action: string, actor: string | null, responsibility: string | null,
  changes: ChangeSet, context: Record<string, unknown> | null,
): string {
  const who = actor ?? 'The system';
  const as = responsibility ? ` as ${responsibility}` : '';
  const what = VERB[action] ?? action;

  if (Array.isArray(changes) && changes.length > 0) {
    const parts = changes.slice(0, 3).map(
      (c) => `${c.field.replace(/_/g, ' ')} from ${fmt(c.old)} to ${fmt(c.new)}`);
    const more = changes.length > 3 ? ` and ${changes.length - 3} more` : '';
    return `${who}${as} changed ${parts.join(', ')}${more}.`;
  }
  const reason = context && typeof context['reason'] === 'string' ? ` — ${context['reason']}` : '';
  return `${who}${as} ${what}${reason}.`;
}
