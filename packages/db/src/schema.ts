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
  | 'delete' | 'archive' | 'export' | 'import' | 'comment' | 'login' | 'config_change'
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

export type EvidenceKind = 'photo' | 'video' | 'document' | 'audio' | 'signature';
export type CaptureMethod = 'in_app_camera' | 'gallery' | 'desktop_upload';
export type EvidencePurpose =
  | 'progress' | 'inspection' | 'issue' | 'closure' | 'receipt'
  | 'safety' | 'before' | 'after' | 'general';
export type EvidenceState =
  'pending_upload' | 'uploaded' | 'ready' | 'failed' | 'quarantined';
export type SyncStatusDb = 'accepted' | 'conflict' | 'rejected';
export type ConflictPolicyDb =
  'accept_as_new' | 'keep_both_and_flag' | 'reject_to_attention';

export interface EvidenceAssetsTable {
  id: Generated<string>; org_id: string; project_id: string | null;
  kind: EvidenceKind; storage_key: string; mime_type: string; size_bytes: string;
  content_hash: Buffer; perceptual_hash: Buffer | null;
  width: number | null; height: number | null; duration_ms: number | null;
  captured_at_device: Timestamp; captured_at_server: Timestamp;
  uploaded_at: Timestamp | null;
  captured_by: string; captured_by_grant_id: string | null;
  responsibility_label: string | null; capture_method: CaptureMethod;
  gps_lat: string | null; gps_lng: string | null; gps_accuracy_m: string | null;
  gps_unavailable_reason: string | null;
  device_model: string | null; app_version: string | null;
  clock_skew_ms: number | null; original_file_timestamp: Timestamp | null;
  state: Generated<EvidenceState>; state_reason: string | null;
  thumbnail_key: string | null;
  client_uuid: string | null; is_offline_origin: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface EvidenceLinksTable {
  id: Generated<string>; org_id: string; project_id: string | null;
  evidence_id: string; entity_type: string; entity_id: string;
  purpose: Generated<EvidencePurpose>; location_id: string | null;
  caption: string | null; sort_order: Generated<number>;
  linked_by: string; linked_by_grant_id: string | null; linked_at: Timestamp;
  unlinked_by: string | null; unlinked_at: Timestamp | null;
  unlink_reason: string | null;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface SyncOperationsTable {
  id: Generated<string>; org_id: string; user_id: string; device_id: string | null;
  client_uuid: string; entity_type: string;
  operation: 'create' | 'update' | 'transition';
  payload: JsonColumn; device_ts: Timestamp | null;
  clock_skew_ms: number | null; base_version: number | null;
  received_at: Timestamp; processed_at: Timestamp | null;
  status: SyncStatusDb; server_entity_id: string | null;
  server_number: string | null; result: JsonColumn; reason: string | null;
  needs_attention: Generated<boolean>;
  resolved_at: Timestamp | null; resolved_by: string | null;
}

export interface SyncConflictsTable {
  id: Generated<string>; org_id: string; project_id: string | null;
  sync_client_uuid: string; entity_type: string; entity_id: string | null;
  policy_applied: ConflictPolicyDb; kept_both: Generated<boolean>;
  other_entity_id: string | null; detail: JsonColumn;
  flagged_for_user_id: string | null; created_at: Timestamp;
  reviewed_at: Timestamp | null; reviewed_by: string | null; resolution: string | null;
}

export interface SyncCursorsTable {
  org_id: string; user_id: string; device_id: string;
  entity_type: string; cursor: string; updated_at: Timestamp;
}

export type VerificationStatus = 'reported' | 'verified' | 'adjusted' | 'rejected';
export type QuantitySource = 'daily_report' | 'measurement' | 'adjustment' | 'import';

export interface DailyReportsTable {
  id: Generated<string>; org_id: string; project_id: string;
  report_date: string; report_number: string | null;
  weather: string | null; work_start: string | null; work_stop: string | null;
  manpower: JsonColumn; notes: string | null;
  status_id: string | null; state_class: Generated<StateClass>;
  submitted_at: Timestamp | null; submitted_by: string | null;
  submitted_by_grant_id: string | null; locked_at: Timestamp | null;
  amends_report_id: string | null; amendment_reason: string | null;
  merged_from_report_id: string | null; has_merge_conflict: Generated<boolean>;
  client_uuid: string | null;
  created_at: Timestamp; created_by: string | null; created_by_grant_id: string | null;
  updated_at: Timestamp; updated_by: string | null; version: Generated<number>;
}

export interface ProgressEntriesTable {
  id: Generated<string>; org_id: string; project_id: string;
  daily_report_id: string | null;
  work_item_id: string; location_id: string;
  /** The CLAIM. Never overwritten by verification (C-3). */
  reported_qty: string;
  /** What the verifier confirmed. Separate column, so the gap survives. */
  verified_qty: string | null;
  unit_id: string; executed_on: string;
  contractor_label: string | null; note: string | null;
  reported_by: string; reported_by_grant_id: string | null;
  reported_responsibility: string | null; reported_at: Timestamp;
  verification_status: Generated<VerificationStatus>;
  verified_by: string | null; verified_by_grant_id: string | null;
  verified_responsibility: string | null; verified_at: Timestamp | null;
  verification_reason: string | null;
  is_over_execution: Generated<boolean>; over_execution_reason: string | null;
  client_uuid: string | null; is_offline_origin: Generated<boolean>;
  device_clock_skew_ms: number | null;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface QuantityLedgerTable {
  id: Generated<string>; org_id: string; project_id: string;
  work_item_id: string; location_id: string;
  source_type: QuantitySource; source_id: string;
  qty: string; unit_id: string; executed_on: string;
  contractor_label: string | null;
  verification_status: VerificationStatus;
  is_billable: Generated<boolean>;
  posted_by: string; posted_by_grant_id: string | null; posted_at: Timestamp;
}

/* ─────────────────────────── Phase 6: approval ─────────────────────────── */

/** Mirrors approval_instances_status_check exactly — the column is text. */
export type ApprovalInstanceStatus =
  | 'in_progress' | 'approved' | 'rejected' | 'withdrawn'
  | 'on_hold' | 'query_raised' | 'blocked';
export type ApprovalStepStatus =
  | 'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked';
export type ApprovalTaskStatus =
  | 'pending' | 'decided' | 'withdrawn' | 'superseded';
export type ApprovalDecision = 'approve' | 'reject' | 'hold' | 'query' | 'reversal';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ActionSubtype = 'task' | 'query' | 'instruction' | 'review';

export interface ApprovalDefinitionsTable {
  id: Generated<string>; org_id: string;
  object_type: string;
  /** 'org' or 'project' — the narrower one wins at submission time. */
  scope_type: string; scope_id: string | null;
  name: string; is_active: Generated<boolean>;
  created_at: Timestamp; created_by: string | null;
  updated_at: Timestamp; updated_by: string | null;
  version: Generated<number>;
}

/**
 * An immutable published spec (BR-20). Editing a workflow makes a new version;
 * instances already in flight keep finishing under the rules they started on.
 */
export interface ApprovalVersionsTable {
  id: Generated<string>; org_id: string;
  definition_id: string; version_no: number;
  spec: JsonColumn;
  effective_from: Timestamp;
  activated_by: string | null; activated_at: Timestamp;
}

export interface ApprovalInstancesTable {
  id: Generated<string>; org_id: string; project_id: string;
  object_type: string; object_id: string;
  definition_id: string; version_id: string;
  /** The spec as it stood at submission — the trail must not shift later. */
  spec_snapshot: JsonColumn;
  /** Present for the schema's sake and CHECK-constrained to NULL in the MVP. */
  amount: string | null; currency: string | null;
  context: JsonColumn;
  status: Generated<ApprovalInstanceStatus>;
  state_class: Generated<StateClass>;
  current_step: Generated<number>;
  submitted_by: string; submitted_by_grant_id: string | null;
  submitted_responsibility: string | null; submitted_at: Timestamp;
  completed_at: Timestamp | null;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface ApprovalStepInstancesTable {
  id: Generated<string>; org_id: string; instance_id: string;
  step_no: number; name: string;
  resolver: string; role_code: string | null; sla_hours: number | null;
  status: Generated<ApprovalStepStatus>;
  started_at: Timestamp | null; completed_at: Timestamp | null;
  sla_due_at: Timestamp | null;
  /** SoD-04: set when this step absorbed an earlier one the actor also held. */
  collapsed_from_step_no: number | null;
}

export interface ApprovalTasksTable {
  id: Generated<string>; org_id: string; project_id: string;
  instance_id: string; step_instance_id: string;
  assignee_user_id: string; assignee_grant_id: string | null;
  status: Generated<ApprovalTaskStatus>;
  assigned_at: Timestamp; sla_due_at: Timestamp | null;
  responded_at: Timestamp | null;
  delegated_from_user_id: string | null;
}

/** Append-only and partitioned: ct_app holds INSERT + SELECT, nothing else. */
export interface ApprovalDecisionsTable {
  id: Generated<string>; org_id: string;
  instance_id: string; task_id: string | null; step_no: number;
  decision: ApprovalDecision; comment: string | null;
  decided_by: string; decided_by_grant_id: string | null;
  responsibility_label: string | null; decided_at: Timestamp;
  ip: string | null; device: string | null;
  is_auto_advance: Generated<boolean>;
}

/* ──────────────────────── Phase 6: issues & actions ────────────────────── */

export interface IssuesTable {
  id: Generated<string>; org_id: string; project_id: string;
  issue_number: string | null; category_id: string | null;
  severity: Generated<IssueSeverity>;
  title: string; description: string | null;
  location_id: string | null; work_item_id: string | null;
  contractor_label: string | null;
  assignee_user_id: string | null; due_date: string | null;
  status_id: string | null; state_class: Generated<StateClass>;
  raised_by: string; raised_by_grant_id: string | null;
  raised_responsibility: string | null; raised_at: Timestamp;
  /** Kept apart from verified_by so SoD-03 has two names to compare. */
  resolved_by: string | null; resolved_by_grant_id: string | null;
  resolved_responsibility: string | null; resolved_at: Timestamp | null;
  resolution_note: string | null;
  verified_by: string | null; verified_by_grant_id: string | null;
  verified_responsibility: string | null; verified_at: Timestamp | null;
  closed_at: Timestamp | null;
  reopen_count: Generated<number>; last_reopen_reason: string | null;
  escalated_at: Timestamp | null; escalated_to_user_id: string | null;
  client_uuid: string | null; is_offline_origin: Generated<boolean>;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

/** One table behind task / query / instruction (PRODUCT_REVIEW C-4). */
export interface ActionsTable {
  id: Generated<string>; org_id: string; project_id: string;
  subtype: ActionSubtype;
  title: string; description: string | null;
  related_entity_type: string | null; related_entity_id: string | null;
  assignee_user_id: string | null; assignee_role_code: string | null;
  accepted_by: string | null; accepted_at: Timestamp | null;
  due_date: string | null; priority: Generated<number>;
  state_class: Generated<StateClass>;
  requires_acknowledgement: Generated<boolean>;
  acknowledged_by: string | null; acknowledged_at: Timestamp | null;
  completed_at: Timestamp | null; completion_note: string | null;
  cancelled_at: Timestamp | null; cancel_reason: string | null;
  created_by: string; created_by_grant_id: string | null;
  created_responsibility: string | null;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface CommentsTable {
  id: Generated<string>; org_id: string; project_id: string;
  entity_type: string; entity_id: string;
  body: string;
  /** An open query blocks closure of its parent — enforced by DB trigger. */
  is_query: Generated<boolean>;
  addressed_to_user_id: string | null;
  answered_by: string | null; answered_at: Timestamp | null;
  answer_body: string | null;
  author_id: string; author_grant_id: string | null;
  author_responsibility: string | null;
  created_at: Timestamp; updated_at: Timestamp; version: Generated<number>;
}

export interface DB {
  'app.daily_reports': DailyReportsTable;
  'app.approval_definitions': ApprovalDefinitionsTable;
  'app.approval_versions': ApprovalVersionsTable;
  'app.approval_instances': ApprovalInstancesTable;
  'app.approval_step_instances': ApprovalStepInstancesTable;
  'app.approval_tasks': ApprovalTasksTable;
  'app.approval_decisions': ApprovalDecisionsTable;
  'app.issues': IssuesTable;
  'app.actions': ActionsTable;
  'app.comments': CommentsTable;
  'app.progress_entries': ProgressEntriesTable;
  'app.quantity_ledger': QuantityLedgerTable;
  'app.evidence_assets': EvidenceAssetsTable;
  'app.evidence_links': EvidenceLinksTable;
  'app.sync_operations': SyncOperationsTable;
  'app.sync_conflicts': SyncConflictsTable;
  'app.sync_cursors': SyncCursorsTable;
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
