import { NotFoundException } from '@nestjs/common';
import type { PermissionKey, RecordQualifier } from '@ct/contracts';
import type { CompiledPermissions } from './permission.service.js';

export interface ScopePredicate {
  /** null = org-wide, no project filter. [] = nothing visible. */
  projectIds: string[] | null;
  qualifier: RecordQualifier;
  /** True when the user holds the key nowhere; the query must return nothing. */
  denyAll: boolean;
}

/**
 * Turns a compiled permission set into the predicate a list query must apply.
 *
 * This exists so no endpoint ever hand-writes scoping. Every list goes through
 * one place, which is the difference between a scoping bug being possible in
 * one file and possible in forty. The tenant predicate itself is not here —
 * that is RLS plus `withTenant`, a layer below.
 */
export function scopeFor(
  perms: CompiledPermissions,
  key: PermissionKey,
): ScopePredicate {
  const entry = perms.keys[key];
  if (!entry) return { projectIds: [], qualifier: 'own_created', denyAll: true };

  const projectIds = entry.orgWide ? null : entry.projectIds;
  return {
    projectIds,
    qualifier: entry.qualifier,
    denyAll: !entry.orgWide && entry.projectIds.length === 0,
  };
}

/**
 * Applies the record-level qualifier to a Kysely where-builder.
 *
 * `all_in_scope` adds nothing. The narrower qualifiers add a predicate on the
 * columns the caller names, so a resource without an `assignee` column simply
 * does not offer `assigned_to_me`.
 */
export interface QualifierColumns {
  createdBy?: string;
  assignee?: string;
}

export function qualifierPredicate(
  qualifier: RecordQualifier,
  userId: string,
  cols: QualifierColumns,
): { column: string; value: string } | null {
  switch (qualifier) {
    case 'all_in_scope':
      return null;
    case 'own_created':
      if (!cols.createdBy) throw new Error('own_created requires a createdBy column');
      return { column: cols.createdBy, value: userId };
    case 'assigned_to_me':
      if (!cols.assignee) throw new Error('assigned_to_me requires an assignee column');
      return { column: cols.assignee, value: userId };
    // Reserved for Phase 2/3. Reaching them now is a wiring mistake, not a
    // runtime condition, so it throws rather than silently widening access.
    case 'my_party':
    case 'my_team':
    case 'my_location_subtree':
      throw new Error(`Record qualifier '${qualifier}' is not implemented in the MVP`);
  }
}

/**
 * The 404-not-403 rule (FR-566), in one place.
 *
 * A record the caller may not see must be indistinguishable from one that does
 * not exist. Returning 403 confirms existence, which is exactly the
 * information an attacker probing for record ids is after.
 */
export function assertVisible<T>(record: T | undefined | null, what = 'Record'): T {
  if (!record) throw new NotFoundException(`${what} not found`);
  return record;
}
