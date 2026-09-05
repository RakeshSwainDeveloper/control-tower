import type { PermissionKey } from './permission-keys.js';
import type { RecordQualifier, ScopeType } from './scope.js';

/**
 * The five MVP seed roles (MVP_PERMISSION_MATRIX.md §4).
 *
 * These are SEED DATA, not code. A tenant clones and edits them; the role
 * editor exists but is not on the onboarding path, because a tenant that never
 * opens a configuration screen must still have a working system (FR-544).
 *
 * The union model means common combinations need no new role: a PM who also
 * verifies holds Project Manager + Site Engineer.
 */
export interface SeedRole {
  code: string;
  name: string;
  description: string;
  isExternal: boolean;
  scopeLevels: ScopeType[];
  /** Default responsibility label recorded on records created under this grant. */
  responsibility: string;
  permissions: Array<[PermissionKey, RecordQualifier?]>;
}

const READ_PROJECT: Array<[PermissionKey, RecordQualifier?]> = [
  ['project.project.read'],
  ['project.location.read'],
  ['report.dashboard.read'],
  ['report.list.read'],
  ['comment.comment.create'],
  ['comment.comment.read'],
  ['action.action.read'],
];

export const SEED_ROLES: SeedRole[] = [
  {
    code: 'company_admin',
    name: 'Company Admin',
    description: 'Sets up and runs the company: users, roles, projects, configuration.',
    isExternal: false,
    scopeLevels: ['org'],
    responsibility: 'Company Admin',
    permissions: [
      ['org.user.create'], ['org.user.read'], ['org.user.update'], ['org.user.deactivate'],
      ['org.role.create'], ['org.role.read'], ['org.role.update'], ['org.grant.manage'],
      ['project.project.create'], ['project.project.read'], ['project.project.update'],
      ['project.location.create'], ['project.location.read'], ['project.location.update'],
      ['project.team.manage'], ['project.work_item.manage'], ['project.work_item.import'],
      ['field.progress.read'], ['field.daily_report.read'], ['field.evidence.read'],
      ['issue.issue.create'], ['issue.issue.read'],
      ['action.action.create'], ['action.action.read'],
      ['approval.instance.read'], ['approval.definition.read'], ['approval.definition.configure'],
      ['report.dashboard.read'], ['report.list.read'], ['report.export.csv'], ['report.pdf.generate'],
      ['audit.log.read'], ['audit.log.export'],
      ['comment.comment.create'], ['comment.comment.read'],
      ['config.masters.manage'], ['config.policy.manage'],
    ],
  },
  {
    code: 'management',
    name: 'Management',
    description:
      'Reads everything, approves, raises issues and queries. Enters no operational data.',
    isExternal: false,
    scopeLevels: ['org'],
    responsibility: 'Management',
    permissions: [
      ['org.user.read'],
      ['project.project.read'], ['project.location.read'],
      // Read-only on the field: management never manufactures a fact about
      // what was built (P-8, FR-013).
      ['field.progress.read'], ['field.daily_report.read'], ['field.evidence.read'],
      ['issue.issue.create'], ['issue.issue.read'],
      ['action.action.create'], ['action.action.read'],
      ['approval.instance.read'], ['approval.task.decide'], ['approval.definition.read'],
      ['report.dashboard.read'], ['report.list.read'], ['report.export.csv'], ['report.pdf.generate'],
      ['audit.log.read'], ['audit.log.export'],
      ['comment.comment.create'], ['comment.comment.read'],
    ],
  },
  {
    code: 'project_manager',
    name: 'Project Manager',
    description: 'Runs a project: team, approvals, issues, verification oversight.',
    isExternal: false,
    scopeLevels: ['project'],
    responsibility: 'Project Manager',
    permissions: [
      ['project.project.read'], ['project.project.update'],
      ['project.location.create'], ['project.location.read'], ['project.location.update'],
      ['project.team.manage'], ['project.work_item.manage'], ['project.work_item.import'],
      ['field.progress.read'], ['field.progress.verify'],
      ['field.daily_report.read'], ['field.daily_report.amend'],
      ['field.evidence.create'], ['field.evidence.read'], ['field.evidence.unlink'],
      ['issue.issue.create'], ['issue.issue.read'], ['issue.issue.update'],
      ['issue.issue.assign'], ['issue.issue.verify'], ['issue.issue.close'], ['issue.issue.reopen'],
      ['action.action.create'], ['action.action.read'],
      ['approval.instance.read'], ['approval.task.decide'], ['approval.definition.read'],
      ['report.dashboard.read'], ['report.list.read'], ['report.export.csv'], ['report.pdf.generate'],
      ['audit.log.read'],
      ['comment.comment.create'], ['comment.comment.read'],
    ],
  },
  {
    code: 'site_engineer',
    name: 'Site Engineer',
    description: 'Verifies quantities; resolves and verifies issues.',
    isExternal: false,
    scopeLevels: ['project'],
    responsibility: 'Site Engineer',
    permissions: [
      ...READ_PROJECT,
      ['field.progress.create'], ['field.progress.read'], ['field.progress.verify'],
      ['field.daily_report.read'], ['field.daily_report.amend'],
      ['field.evidence.create'], ['field.evidence.read'], ['field.evidence.unlink'],
      ['issue.issue.create'], ['issue.issue.read'], ['issue.issue.update'],
      ['issue.issue.assign'], ['issue.issue.resolve'], ['issue.issue.verify'],
      ['issue.issue.close'], ['issue.issue.reopen'],
      ['action.action.create'],
      ['approval.instance.read'],
      ['report.pdf.generate'],
    ],
  },
  {
    code: 'site_supervisor',
    name: 'Site Supervisor',
    description: 'Records progress and raises issues. Mobile-first.',
    isExternal: false,
    scopeLevels: ['project'],
    responsibility: 'Site Supervisor',
    permissions: [
      ...READ_PROJECT,
      // own_created: a supervisor edits their own entries before submission,
      // and nobody else's (FR-048).
      ['field.progress.create'], ['field.progress.read'], ['field.progress.update', 'own_created'],
      ['field.daily_report.create'], ['field.daily_report.read'], ['field.daily_report.submit'],
      ['field.evidence.create'], ['field.evidence.read'],
      ['issue.issue.create'], ['issue.issue.read'], ['issue.issue.update', 'assigned_to_me'],
      ['issue.issue.resolve'],
      ['approval.instance.read'],
      ['report.pdf.generate'],
    ],
  },
];
