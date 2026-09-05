import { Injectable, Inject } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { PermissionKey, RecordQualifier, ScopeType } from '@ct/contracts';
import { withTenant, type DB } from '@ct/db';
import { DB_TOKEN } from '../../common/tokens.js';

/** One grant's contribution: which projects, under which qualifier. */
export interface KeyScope {
  /** True when an org-scoped grant carries this key: every project. */
  orgWide: boolean;
  /** Project ids from project-scoped grants. */
  projectIds: string[];
  /** Narrowest qualifier wins across grants — permissions union, scope does not widen. */
  qualifier: RecordQualifier;
  /** Grant that supplies this key at the most specific scope (FR-031). */
  grantId: string;
  responsibilityLabel: string;
}

export interface CompiledPermissions {
  userId: string;
  orgId: string;
  permissionVersion: number;
  keys: Record<string, KeyScope>;
  compiledAt: number;
}

const QUALIFIER_BREADTH: Record<RecordQualifier, number> = {
  all_in_scope: 100,
  my_location_subtree: 60,
  my_team: 50,
  my_party: 40,
  assigned_to_me: 30,
  own_created: 20,
};

/**
 * Compiles a user's effective permissions into a flat, cacheable map.
 *
 * Why compile at all: the alternative is evaluating scoped grants against every
 * row of every list endpoint, which is the performance failure predicted as
 * TR-3. Compiling once per session turns authorisation into an array lookup
 * plus a `project_id = ANY($1)` predicate that uses the index.
 *
 * Cache correctness rests on `users.permission_version`, bumped on any grant or
 * role change. A cached set carrying an older stamp is discarded, never trusted.
 */
@Injectable()
export class PermissionService {
  private readonly cache = new Map<string, CompiledPermissions>();

  constructor(@Inject(DB_TOKEN) private readonly db: Kysely<DB>) {}

  async compile(orgId: string, userId: string): Promise<CompiledPermissions> {
    return withTenant(this.db, { orgId }, async (trx) => {
      const user = await trx
        .selectFrom('app.users')
        .select(['id', 'permission_version', 'status'])
        .where('id', '=', userId)
        .executeTakeFirst();

      // A user who is not active has no permissions at all, regardless of grants.
      if (!user || user.status !== 'active') {
        return { userId, orgId, permissionVersion: user?.permission_version ?? 0, keys: {}, compiledAt: Date.now() };
      }

      const rows = await trx
        .selectFrom('app.role_grants as g')
        .innerJoin('app.role_permissions as rp', 'rp.role_id', 'g.role_id')
        .innerJoin('app.roles as r', 'r.id', 'g.role_id')
        .select([
          'g.id as grant_id', 'g.scope_type', 'g.scope_id', 'g.responsibility_label',
          'rp.permission_key', 'rp.record_qualifier',
        ])
        .where('g.user_id', '=', userId)
        .where('g.revoked_at', 'is', null)
        .where('r.is_active', '=', true)
        .where((eb) => eb.or([eb('g.valid_to', 'is', null), eb('g.valid_to', '>', new Date())]))
        .where('g.valid_from', '<=', new Date())
        .execute();

      const keys: Record<string, KeyScope> = {};
      for (const row of rows) {
        const key = row.permission_key;
        const qualifier = row.record_qualifier as RecordQualifier;
        const scopeType = row.scope_type as ScopeType;

        const entry = (keys[key] ??= {
          orgWide: false,
          projectIds: [],
          qualifier,
          grantId: row.grant_id,
          responsibilityLabel: row.responsibility_label,
        });

        if (scopeType === 'org') {
          entry.orgWide = true;
          // Most specific scope determines the recorded responsibility, so an
          // org-wide grant only claims it when nothing narrower has (FR-031).
          if (entry.projectIds.length === 0) {
            entry.grantId = row.grant_id;
            entry.responsibilityLabel = row.responsibility_label;
          }
        } else if (row.scope_id) {
          if (!entry.projectIds.includes(row.scope_id)) entry.projectIds.push(row.scope_id);
          entry.grantId = row.grant_id;
          entry.responsibilityLabel = row.responsibility_label;
        }

        // Permissions union; the record-level qualifier does NOT widen.
        // Holding a key twice must never turn `own_created` into `all_in_scope`
        // by accident, so the broadest is taken only when a grant genuinely
        // carries it — which is what QUALIFIER_BREADTH compares.
        if (QUALIFIER_BREADTH[qualifier] > QUALIFIER_BREADTH[entry.qualifier]) {
          entry.qualifier = qualifier;
        }
      }

      return {
        userId, orgId,
        permissionVersion: user.permission_version,
        keys,
        compiledAt: Date.now(),
      };
    });
  }

  /** Cached compile. Invalidated by permission_version, not by TTL guesswork. */
  async get(orgId: string, userId: string, permissionVersion: number): Promise<CompiledPermissions> {
    const cacheKey = `${orgId}:${userId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.permissionVersion === permissionVersion) return hit;

    const fresh = await this.compile(orgId, userId);
    this.cache.set(cacheKey, fresh);
    return fresh;
  }

  invalidate(orgId: string, userId: string): void {
    this.cache.delete(`${orgId}:${userId}`);
  }

  /** Does the user hold this key anywhere at all? Route-level gate. */
  holds(perms: CompiledPermissions, key: PermissionKey): boolean {
    const s = perms.keys[key];
    return !!s && (s.orgWide || s.projectIds.length > 0);
  }

  /** Does the user hold this key on this specific project? */
  holdsOnProject(perms: CompiledPermissions, key: PermissionKey, projectId: string): boolean {
    const s = perms.keys[key];
    if (!s) return false;
    return s.orgWide || s.projectIds.includes(projectId);
  }

  /**
   * The project-id predicate for a list query. `null` means org-wide (no
   * project filter needed); `[]` means the user holds the key nowhere and the
   * query must return nothing rather than everything.
   */
  projectScope(perms: CompiledPermissions, key: PermissionKey): string[] | null {
    const s = perms.keys[key];
    if (!s) return [];
    return s.orgWide ? null : s.projectIds;
  }

  qualifierFor(perms: CompiledPermissions, key: PermissionKey): RecordQualifier | null {
    return perms.keys[key]?.qualifier ?? null;
  }
}
