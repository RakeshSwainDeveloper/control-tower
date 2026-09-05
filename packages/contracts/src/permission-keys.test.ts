import { describe, it, expect } from 'vitest';
import { PERMISSION_KEYS, moduleOf, isPermissionKey } from './permission-keys.js';
import { STATE_CLASSES } from './state-classes.js';

describe('permission key catalogue', () => {
  it('has exactly 52 keys, as specified in MVP_PERMISSION_MATRIX.md §3', () => {
    expect(PERMISSION_KEYS.length).toBe(52);
  });

  it('contains no duplicates', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('every key is module.resource.action', () => {
    for (const k of PERMISSION_KEYS) {
      expect(k, `bad key shape: ${k}`).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it('group counts match the spec', () => {
    const counts = PERMISSION_KEYS.reduce<Record<string, number>>((a, k) => {
      const m = moduleOf(k); a[m] = (a[m] ?? 0) + 1; return a;
    }, {});
    expect(counts).toEqual({
      org: 8, project: 9, field: 11,
      issue: 8, action: 2,        // "Issues & Actions (10)"
      approval: 4,
      report: 4, audit: 2,        // "Reporting & Audit (6)"
      comment: 2, config: 2,
    });
  });

  it('rejects invented keys', () => {
    expect(isPermissionKey('field.progress.create')).toBe(true);
    expect(isPermissionKey('finance.payment.approve')).toBe(false); // no money in MVP
    expect(isPermissionKey('made.up.key')).toBe(false);
  });
});

describe('state classes', () => {
  it('are fixed and unique', () => {
    expect(new Set(STATE_CLASSES).size).toBe(STATE_CLASSES.length);
    expect(STATE_CLASSES).toContain('approved');
    expect(STATE_CLASSES).toContain('verified');
  });
});
