/**
 * Separation of duty — structural rules, FIXED IN CODE.
 * (FR-040/041/042, MVP_PERMISSION_MATRIX.md §6)
 *
 * These are not configurable by anyone, including platform staff.
 * SoD-04 is defined for Phase 2 (multi-step chains); MVP approvals are
 * single-step so it cannot trigger yet.
 */
export const SOD_RULES = {
  'SoD-01': 'A user may never approve a record they created.',
  'SoD-02': 'A user may never verify a quantity they reported.',
  'SoD-03': 'A user may never verify or close an issue whose resolution they performed.',
  'SoD-04': 'A user may not occupy two decision steps of one approval chain.', // P2
} as const;

export type SodRuleId = keyof typeof SOD_RULES;

export class SodViolationError extends Error {
  constructor(
    public readonly rule: SodRuleId,
    public readonly detail?: string,
  ) {
    super(`${rule}: ${SOD_RULES[rule]}${detail ? ` (${detail})` : ''}`);
    this.name = 'SodViolationError';
  }
}
