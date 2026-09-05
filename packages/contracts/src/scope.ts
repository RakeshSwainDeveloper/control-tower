/**
 * Grant scoping and record-level qualifiers.
 * (FR-021, FR-048, MVP_PERMISSION_MATRIX.md §2)
 */

/** MVP uses org + project. 'company' is accepted by the schema but unused,
 *  so Phase 2 activates it without a migration. */
export const SCOPE_TYPES = ['org', 'company', 'project'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const MVP_SCOPE_TYPES: readonly ScopeType[] = ['org', 'project'];

/**
 * Record-level qualifiers. MVP implements the first three; the remaining
 * three are reserved so Phase 2 (external users, org charts, large sites)
 * activates them without an enum migration.
 */
export const RECORD_QUALIFIERS = [
  'all_in_scope',
  'own_created',
  'assigned_to_me',
  'my_party',              // P2 — external users
  'my_team',               // P2 — reporting lines
  'my_location_subtree',   // P2 — large sites
] as const;
export type RecordQualifier = (typeof RECORD_QUALIFIERS)[number];

export const MVP_RECORD_QUALIFIERS: readonly RecordQualifier[] = [
  'all_in_scope', 'own_created', 'assigned_to_me',
];

/** User types. MVP creates only internal + platform_staff. */
export const USER_TYPES = [
  'internal',
  'external_contractor',   // P2
  'external_vendor',       // P2
  'external_consultant',   // P2
  'external_client',       // P2
  'platform_staff',
] as const;
export type UserType = (typeof USER_TYPES)[number];
