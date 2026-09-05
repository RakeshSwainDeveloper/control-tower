/**
 * Kysely database types.
 *
 * Grows migration by migration. Phase 1 covers 0001 + 0002 only; each later
 * phase adds its tables here in the same commit as its migration.
 */
import type { ColumnType, Generated } from 'kysely';

/**
 * A column with a database default: readable as Date, optional on insert.
 *
 * Do NOT wrap these in Generated<>. Generated<ColumnType<...>> does not
 * compose — the wrapper hides the inner insert/update types, Kysely then
 * computes the wrong ValueExpression, and every `new Date()` and
 * `JSON.stringify()` is rejected with an unreadable error.
 */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** JSONB column: read as unknown, write as a serialised string. */
export type JsonColumn = ColumnType<unknown, string | undefined, string>;

export type StateClass =
  | 'draft' | 'submitted' | 'in_review' | 'in_approval' | 'approved' | 'rejected'
  | 'in_progress' | 'resolved' | 'verified' | 'closed' | 'cancelled' | 'on_hold' | 'void';

export type ScopeType = 'org' | 'company' | 'project';
export type RecordQualifier =
  | 'all_in_scope' | 'own_created' | 'assigned_to_me'
  | 'my_party' | 'my_team' | 'my_location_subtree';
export type UserType =
  | 'internal' | 'external_contractor' | 'external_vendor'
  | 'external_consultant' | 'external_client' | 'platform_staff';
export type OrgStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'read_only' | 'closed';
export type AuditAction =
  | 'create' | 'update' | 'transition' | 'approve' | 'reject' | 'verify'
  | 'delete' | 'archive' | 'export' | 'import' | 'login' | 'config_change'
  | 'impersonation';
export type AuditSource = 'web' | 'mobile' | 'api' | 'sync' | 'job' | 'impersonation' | 'system';

export interface SchemaMigrationsTable {
  version: string; checksum: string; applied_at: Timestamp; duration_ms: number;
}

export interface PermissionKeysTable {
  key: string; module: string; resource: string; action: string;
  description: string | null; is_deprecated: Generated<boolean>;
  created_at: Timestamp;
}

export interface PlatformUsersTable {
  id: Generated<string>; email: string; name: string; password_hash: string;
  platform_role: 'platform_owner' | 'platform_support';
  mfa_secret: string | null; mfa_enabled: Generated<boolean>;
  is_active: Generated<boolean>; last_login_at: Timestamp | null;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

/** Platform catalogue of flags. No org_id: this describes the product, not a
 *  customer, so it needs no RLS. See migration 0005. */
export interface FeatureFlagDefsTable {
  flag_key: string; description: string;
  default_enabled: Generated<boolean>; is_active: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

/** Per-tenant override of a flag. Tenant data, RLS forced. */
export interface OrgFeatureFlagsTable {
  id: Generated<string>; org_id: string; flag_key: string; is_enabled: boolean;
  set_by: string | null; reason: string | null;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface OrganizationsTable {
  id: Generated<string>; legal_name: string; display_name: string; slug: string;
  country: Generated<string>; currency: Generated<string>; timezone: Generated<string>;
  locale: Generated<string>; data_region: Generated<string>;
  status: Generated<OrgStatus>; suspended_reason: string | null;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface CompaniesTable {
  id: Generated<string>; org_id: string; name: string;
  tax_registration: string | null; address: JsonColumn;
  is_default: Generated<boolean>; is_active: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface AuditLogTable {
  id: Generated<string>; org_id: string; project_id: string | null;
  entity_type: string; entity_id: string; action: AuditAction;
  actor_user_id: string | null; actor_grant_id: string | null;
  responsibility_label: string | null;
  occurred_at: Timestamp; source: Generated<AuditSource>;
  device_id: string | null; app_version: string | null; ip: string | null;
  correlation_id: string | null;
  changes: JsonColumn; context: JsonColumn;
}

export interface PlatformAuditLogTable {
  id: Generated<string>; platform_user_id: string | null; platform_role: string | null;
  action: string; target_type: string | null; target_id: string | null;
  target_org_id: string | null; reason: string | null;
  changes: JsonColumn; ip: string | null; correlation_id: string | null;
  occurred_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>; org_id: string; name: string;
  email: string | null; phone: string | null; user_type: UserType;
  party_type: string | null; party_id: string | null;
  password_hash: string | null; mfa_secret: string | null;
  mfa_enabled: Generated<boolean>; locale: Generated<string>;
  status: Generated<'invited' | 'active' | 'suspended' | 'deactivated'>;
  permission_version: Generated<number>;
  last_login_at: Timestamp | null; failed_logins: Generated<number>;
  locked_until: Timestamp | null;
  created_at: Timestamp; created_by: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface InvitationsTable {
  id: Generated<string>; org_id: string; email: string | null; phone: string | null;
  name: string; user_type: Generated<UserType>; token_hash: string;
  expires_at: Timestamp; accepted_at: Timestamp | null;
  accepted_user_id: string | null; revoked_at: Timestamp | null;
  revoked_by: string | null; invited_by: string; pending_grants: JsonColumn;
  created_at: Timestamp; created_by: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface UserSessionsTable {
  id: Generated<string>; org_id: string; user_id: string;
  refresh_token_hash: string; parent_session_id: string | null;
  device_id: string | null; device_label: string | null;
  user_agent: string | null; ip: string | null;
  issued_at: Timestamp; last_seen_at: Timestamp;
  expires_at: Timestamp; revoked_at: Timestamp | null;
  revoked_reason: string | null; reused_at: Timestamp | null;
}

export interface OtpChallengesTable {
  id: Generated<string>; org_id: string | null; phone: string; code_hash: string;
  attempts: Generated<number>; max_attempts: Generated<number>;
  expires_at: Timestamp; consumed_at: Timestamp | null;
  ip: string | null; created_at: Timestamp;
}

export interface RolesTable {
  id: Generated<string>; org_id: string; code: string; name: string;
  description: string | null; is_system: Generated<boolean>;
  is_external: Generated<boolean>;
  applicable_scope_levels: Generated<ScopeType[]>;
  is_active: Generated<boolean>;
  created_at: Timestamp; created_by: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface RolePermissionsTable {
  org_id: string; role_id: string; permission_key: string;
  record_qualifier: Generated<RecordQualifier>;
}

export interface RoleGrantsTable {
  id: Generated<string>; org_id: string; user_id: string; role_id: string;
  scope_type: ScopeType; scope_id: string | null;
  responsibility_label: string;
  valid_from: Timestamp; valid_to: Timestamp | null;
  granted_by: string; revoked_at: Timestamp | null; revoked_by: string | null;
  revoke_reason: string | null;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface ImpersonationSessionsTable {
  id: Generated<string>; platform_user_id: string; target_org_id: string;
  target_user_id: string; reason: string; allow_writes: Generated<boolean>;
  started_at: Timestamp; expires_at: Timestamp;
  ended_at: Timestamp | null; ended_reason: string | null; ip: string | null;
}

export type UnitDimension = 'length' | 'area' | 'volume' | 'mass' | 'count' | 'time';
export type LocationStatus = 'not_started' | 'in_progress' | 'complete' | 'handed_over';

export interface StatusesTable {
  id: Generated<string>; org_id: string; entity_type: string; code: string;
  label: string; state_class: StateClass; sort_order: Generated<number>;
  colour: string | null; is_default: Generated<boolean>;
  is_terminal: Generated<boolean>; is_active: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface UnitsTable {
  id: Generated<string>; org_id: string; code: string; name: string;
  dimension: UnitDimension; base_factor: Generated<string>;
  decimal_places: Generated<number>; is_active: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface MasterDataTable {
  id: Generated<string>; org_id: string; kind: string; code: string;
  name: string; description: string | null; attributes: JsonColumn;
  sort_order: Generated<number>; is_active: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface NumberingSeriesTable {
  id: Generated<string>; org_id: string; entity_type: string;
  prefix: Generated<string>; separator: Generated<string>;
  include_project_code: Generated<boolean>; include_fy: Generated<boolean>;
  sequence_width: Generated<number>; reset_policy: Generated<string>;
  created_at: Timestamp; updated_at: Timestamp;
  version: Generated<number>;
}

export interface NumberingCountersTable {
  org_id: string; entity_type: string; scope_key: string; last_value: Generated<string>;
}

export interface ProjectsTable {
  id: Generated<string>; org_id: string; company_id: string;
  code: string; name: string; description: string | null; client_name: string | null;
  planned_start: string | null; planned_finish: string | null;
  actual_start: string | null; actual_finish: string | null;
  status_id: string | null; state_class: Generated<StateClass>;
  accountable_manager_user_id: string; commercial_owner_user_id: string;
  contract_value: string | null; currency: string | null;
  location_label_scheme: Generated<string[]>; timezone: Generated<string>;
  geo_lat: string | null; geo_lng: string | null;
  created_at: Timestamp; created_by: string | null;
  created_by_grant_id: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface LocationsTable {
  id: Generated<string>; org_id: string; project_id: string;
  parent_id: string | null; level_index: Generated<number>;
  level_name: string | null; code: string; name: string;
  path: Generated<string>; attributes: JsonColumn;
  status: Generated<LocationStatus>; sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Timestamp; created_by: string | null;
  created_by_grant_id: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface LocationPathsTable {
  location_id: string; org_id: string; project_id: string;
  display_path: string; depth: number;
}

export interface WorkItemsTable {
  id: Generated<string>; org_id: string; project_id: string;
  parent_id: string | null; code: string; description: string;
  unit_id: string; planned_qty: Generated<string>;
  work_category_id: string | null; spec_reference: string | null;
  wbs_node_id: string | null; cost_head_id: string | null; planned_rate: string | null;
  is_active: Generated<boolean>; sort_order: Generated<number>;
  created_at: Timestamp; created_by: string | null;
  created_by_grant_id: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

export interface WorkItemLocationsTable {
  id: Generated<string>; org_id: string; project_id: string;
  work_item_id: string; location_id: string; planned_qty: string;
  created_at: Timestamp; created_by: string | null;
  updated_at: Timestamp; version: Generated<number>;
}

export interface ImportJobsTable {
  id: Generated<string>; org_id: string; project_id: string;
  entity_type: string; filename: string | null;
  status: Generated<'previewing' | 'confirmed' | 'cancelled' | 'failed'>;
  column_map: JsonColumn; total_rows: Generated<number>;
  valid_rows: Generated<number>; error_rows: Generated<number>;
  rows: JsonColumn; errors: JsonColumn;
  confirmed_at: Timestamp | null; expires_at: Timestamp;
  created_at: Timestamp; created_by: string | null;
  version: Generated<number>;
}

export interface DB {
  'app.statuses': StatusesTable;
  'app.units': UnitsTable;
  'app.master_data': MasterDataTable;
  'app.numbering_series': NumberingSeriesTable;
  'app.numbering_counters': NumberingCountersTable;
  'app.projects': ProjectsTable;
  'app.locations': LocationsTable;
  'app.location_paths': LocationPathsTable;
  'app.work_items': WorkItemsTable;
  'app.work_item_locations': WorkItemLocationsTable;
  'app.import_jobs': ImportJobsTable;
  'app.users': UsersTable;
  'app.invitations': InvitationsTable;
  'app.user_sessions': UserSessionsTable;
  'app.otp_challenges': OtpChallengesTable;
  'app.roles': RolesTable;
  'app.role_permissions': RolePermissionsTable;
  'app.role_grants': RoleGrantsTable;
  'app.impersonation_sessions': ImpersonationSessionsTable;
  'app.schema_migrations': SchemaMigrationsTable;
  'app.permission_keys': PermissionKeysTable;
  'app.platform_users': PlatformUsersTable;
  'app.feature_flag_defs': FeatureFlagDefsTable;
  'app.org_feature_flags': OrgFeatureFlagsTable;
  'app.organizations': OrganizationsTable;
  'app.companies': CompaniesTable;
  'app.audit_log': AuditLogTable;
  'app.platform_audit_log': PlatformAuditLogTable;
}
