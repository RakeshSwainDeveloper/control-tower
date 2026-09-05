/**
 * Permission matrix — MVP_PERMISSION_MATRIX.md §5 asserted as code.
 *
 * The matrix in the document is seed configuration, but the SHAPE of it is a
 * product decision: management reads and never creates, a supervisor edits only
 * their own entries, an engineer verifies but does not administer. Those are
 * the claims the product makes; these tests are what stop a well-meaning role
 * edit from quietly contradicting them.
 */
import { describe, it, expect } from 'vitest';
import { SEED_ROLES, PERMISSION_KEYS, type PermissionKey } from '@ct/contracts';

const byCode = new Map(SEED_ROLES.map((r) => [r.code, r]));
const keysOf = (code: string) => new Set(byCode.get(code)!.permissions.map(([k]) => k));
const qualifierOf = (code: string, key: PermissionKey) =>
  byCode.get(code)!.permissions.find(([k]) => k === key)?.[1] ?? 'all_in_scope';

describe('seed role shape', () => {
  it('ships exactly the five MVP roles', () => {
    expect(SEED_ROLES.map((r) => r.code).sort()).toEqual([
      'company_admin', 'management', 'project_manager', 'site_engineer', 'site_supervisor',
    ]);
  });

  it('every referenced key exists in the code catalogue', () => {
    const valid = new Set<string>(PERMISSION_KEYS);
    for (const role of SEED_ROLES) {
      for (const [key] of role.permissions) {
        expect(valid.has(key), `${role.code} references unknown key ${key}`).toBe(true);
      }
    }
  });

  it('no role holds a key twice', () => {
    for (const role of SEED_ROLES) {
      const keys = role.permissions.map(([k]) => k);
      expect(new Set(keys).size, `${role.code} has duplicate keys`).toBe(keys.length);
    }
  });

  it('every role carries a responsibility label for the audit trail', () => {
    // FR-030: records say "as Project Manager", not just who acted. A blank
    // label would produce an unattributable record.
    for (const role of SEED_ROLES) {
      expect(role.responsibility.length, `${role.code} has no responsibility`).toBeGreaterThan(2);
    }
  });
});

describe('management is read-only on operational data', () => {
  // P-8 / FR-013: "the owner never performs operational data entry, but always
  // has a first-class way to express a decision, a question or an instruction."
  const mgmt = keysOf('management');

  it.each([
    'field.progress.create',
    'field.progress.update',
    'field.progress.verify',
    'field.daily_report.create',
    'field.daily_report.submit',
    'field.evidence.create',
  ] as PermissionKey[])('cannot %s', (key) => {
    expect(mgmt.has(key)).toBe(false);
  });

  it.each([
    'field.progress.read',
    'field.daily_report.read',
    'field.evidence.read',
    'report.dashboard.read',
    'audit.log.read',
  ] as PermissionKey[])('can %s', (key) => {
    expect(mgmt.has(key)).toBe(true);
  });

  it('can still raise issues, comments and approve — a decision is not data entry', () => {
    expect(mgmt.has('issue.issue.create')).toBe(true);
    expect(mgmt.has('comment.comment.create')).toBe(true);
    expect(mgmt.has('approval.task.decide')).toBe(true);
  });
});

describe('site supervisor', () => {
  const sup = keysOf('site_supervisor');

  it('records progress but cannot verify it', () => {
    // Verification by the claimant is SoD-02; the role shape makes it moot
    // for the common case rather than relying on the runtime check alone.
    expect(sup.has('field.progress.create')).toBe(true);
    expect(sup.has('field.progress.verify')).toBe(false);
  });

  it('edits only its OWN progress entries', () => {
    expect(qualifierOf('site_supervisor', 'field.progress.update')).toBe('own_created');
  });

  it('updates only issues assigned to it', () => {
    expect(qualifierOf('site_supervisor', 'issue.issue.update')).toBe('assigned_to_me');
  });

  it('holds no administrative key', () => {
    for (const key of sup) {
      expect(key.startsWith('org.'), `supervisor should not hold ${key}`).toBe(false);
      expect(key.startsWith('config.'), `supervisor should not hold ${key}`).toBe(false);
    }
  });
});

describe('site engineer', () => {
  const eng = keysOf('site_engineer');

  it('verifies quantities and issues', () => {
    expect(eng.has('field.progress.verify')).toBe(true);
    expect(eng.has('issue.issue.verify')).toBe(true);
  });

  it('does not administer users or roles', () => {
    expect(eng.has('org.user.create')).toBe(false);
    expect(eng.has('org.role.create')).toBe(false);
    expect(eng.has('org.grant.manage')).toBe(false);
  });
});

describe('company admin', () => {
  const admin = keysOf('company_admin');

  it('administers users, roles, grants and workflows', () => {
    for (const key of ['org.user.create', 'org.role.create', 'org.grant.manage',
                       'approval.definition.configure', 'config.policy.manage'] as PermissionKey[]) {
      expect(admin.has(key), `admin should hold ${key}`).toBe(true);
    }
  });

  it('does NOT record or verify field data', () => {
    // Administering the company is not the same as working on the site. An
    // admin who could file progress could manufacture a fact about what was
    // built, which is the thing the whole evidence chain exists to prevent.
    expect(admin.has('field.progress.create')).toBe(false);
    expect(admin.has('field.progress.verify')).toBe(false);
    expect(admin.has('field.daily_report.submit')).toBe(false);
  });
});

describe('scope levels are coherent', () => {
  it('org-level roles are org-scoped; site roles are project-scoped', () => {
    expect(byCode.get('company_admin')!.scopeLevels).toEqual(['org']);
    expect(byCode.get('management')!.scopeLevels).toEqual(['org']);
    for (const code of ['project_manager', 'site_engineer', 'site_supervisor']) {
      expect(byCode.get(code)!.scopeLevels).toEqual(['project']);
    }
  });
});

describe('catalogue coverage', () => {
  it('every permission key is reachable through at least one seed role', () => {
    // An unreachable key is either dead code or a role gap. Either way the
    // catalogue and the roles have drifted and somebody should look.
    const covered = new Set(SEED_ROLES.flatMap((r) => r.permissions.map(([k]) => k)));
    const orphans = PERMISSION_KEYS.filter((k) => !covered.has(k));
    expect(orphans, `keys no seed role grants: ${orphans.join(', ')}`).toEqual([]);
  });
});
