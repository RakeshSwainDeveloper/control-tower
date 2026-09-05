/**
 * Permission key catalogue — DEFINED IN CODE, never invented by a tenant.
 * (FR-022, MVP_PERMISSION_MATRIX.md §3 — exactly 52 keys.)
 *
 * What is dynamic is the COMPOSITION of these keys into roles, and the SCOPING
 * of role grants. Tenants compose; they do not invent. Code must be able to
 * check something specific.
 *
 * Keys are added, never silently removed (FR-064).
 */
export const PERMISSION_KEYS = [
  // ── Organization (8) ────────────────────────────────────────
  'org.user.create', 'org.user.read', 'org.user.update', 'org.user.deactivate',
  'org.role.create', 'org.role.read', 'org.role.update', 'org.grant.manage',

  // ── Project (9) ─────────────────────────────────────────────
  'project.project.create', 'project.project.read', 'project.project.update',
  'project.location.create', 'project.location.read', 'project.location.update',
  'project.team.manage', 'project.work_item.manage', 'project.work_item.import',

  // ── Field (11) ──────────────────────────────────────────────
  'field.progress.create', 'field.progress.read', 'field.progress.update',
  'field.progress.verify',
  'field.daily_report.create', 'field.daily_report.read',
  'field.daily_report.submit', 'field.daily_report.amend',
  'field.evidence.create', 'field.evidence.read', 'field.evidence.unlink',

  // ── Issues & Actions (10) ───────────────────────────────────
  'issue.issue.create', 'issue.issue.read', 'issue.issue.update',
  'issue.issue.assign', 'issue.issue.resolve', 'issue.issue.verify',
  'issue.issue.close', 'issue.issue.reopen',
  'action.action.create', 'action.action.read',

  // ── Approvals (4) ───────────────────────────────────────────
  'approval.instance.read', 'approval.task.decide',
  'approval.definition.read', 'approval.definition.configure',

  // ── Reporting & Audit (6) ───────────────────────────────────
  'report.dashboard.read', 'report.list.read', 'report.export.csv',
  'report.pdf.generate', 'audit.log.read', 'audit.log.export',

  // ── Comments (2) ────────────────────────────────────────────
  'comment.comment.create', 'comment.comment.read',

  // ── Configuration (2) ───────────────────────────────────────
  'config.masters.manage', 'config.policy.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(v: string): v is PermissionKey {
  return PERMISSION_KEY_SET.has(v);
}

/** Grouping used by the role editor UI. */
export const PERMISSION_MODULES = {
  org: 'Organization',
  project: 'Project',
  field: 'Field',
  issue: 'Issues',
  action: 'Actions',
  approval: 'Approvals',
  report: 'Reporting',
  audit: 'Audit',
  comment: 'Comments',
  config: 'Configuration',
} as const;

export function moduleOf(key: PermissionKey): string {
  return key.split('.')[0]!;
}
