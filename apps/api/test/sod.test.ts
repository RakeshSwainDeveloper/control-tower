/**
 * Separation of duty — the three structural rules.
 *
 * These are fixed in code with no configuration path that disables them, for
 * any tenant, and no platform-staff override. `app.sod_policies` exists for the
 * configurable conflict PAIRS of a later phase and deliberately contains none
 * of these.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withoutTenant, SodViolationError, type DB } from '@ct/db';
import { SodService } from '../src/modules/access/sod.service.js';
import { appDb } from './helpers.js';

const sod = new SodService();
const RAMESH = { userId: 'user-ramesh' };
const ANITA = { userId: 'user-anita' };

describe('SoD-01 · never approve what you created', () => {
  it('refuses the creator', () => {
    expect(() => sod.assertCanApprove(RAMESH, { createdBy: RAMESH.userId }))
      .toThrow(SodViolationError);
  });

  it('permits anyone else', () => {
    expect(() => sod.assertCanApprove(ANITA, { createdBy: RAMESH.userId })).not.toThrow();
  });

  it('carries the rule id, so the refusal is comprehensible to the user', () => {
    // "You cannot approve a record you created" must be legible. An opaque 403
    // teaches people to look for a way around it.
    try {
      sod.assertCanApprove(RAMESH, { createdBy: RAMESH.userId });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as SodViolationError).rule).toBe('SoD-01');
      expect((e as Error).message).toMatch(/cannot approve a record you created/i);
    }
  });

  it('does not fire when the creator is unknown', () => {
    // A system-generated record has no human creator; refusing it would make
    // it unapprovable by anybody.
    expect(() => sod.assertCanApprove(RAMESH, { createdBy: null })).not.toThrow();
  });
});

describe('SoD-02 · never verify a quantity you reported', () => {
  it('refuses the reporter', () => {
    expect(() => sod.assertCanVerifyQuantity(RAMESH, { reportedBy: RAMESH.userId }))
      .toThrow(/SoD-02/);
  });
  it('permits a different verifier', () => {
    expect(() => sod.assertCanVerifyQuantity(ANITA, { reportedBy: RAMESH.userId })).not.toThrow();
  });
});

describe('SoD-03 · never verify work you performed', () => {
  it('refuses the resolver', () => {
    expect(() => sod.assertCanVerifyIssue(ANITA, { resolvedBy: ANITA.userId }))
      .toThrow(/SoD-03/);
  });
  it('permits a different verifier', () => {
    expect(() => sod.assertCanVerifyIssue(RAMESH, { resolvedBy: ANITA.userId })).not.toThrow();
  });
});

describe('the UI can ask without the server trusting the answer', () => {
  it('wouldRefuse mirrors the assert, so a control is hidden rather than greyed out', () => {
    // FR-020: a disabled control advertises what a user cannot have and invites
    // a workaround. The client asks this to decide whether to RENDER; the
    // server still runs the assert.
    expect(sod.wouldRefuse('SoD-01', RAMESH.userId, RAMESH.userId)).toBe(true);
    expect(sod.wouldRefuse('SoD-01', RAMESH.userId, ANITA.userId)).toBe(false);
    expect(sod.wouldRefuse('SoD-02', RAMESH.userId, null)).toBe(false);
  });
});

describe('the structural rules are not configurable', () => {
  let db: Kysely<DB>;
  beforeAll(() => { db = appDb(); });
  afterAll(async () => { await db.destroy(); });

  it('sod_policies contains no row for SoD-01..03', async () => {
    const rows = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ pair_code: string }>`
        SELECT pair_code FROM app.sod_policies WHERE pair_code LIKE 'SoD-0%'
      `.execute(trx);
      return r.rows;
    });
    // If a structural rule ever appears here, someone has made it switchable.
    expect(rows).toEqual([]);
  });
});
