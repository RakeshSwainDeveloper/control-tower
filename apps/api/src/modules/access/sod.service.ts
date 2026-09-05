import { Injectable } from '@nestjs/common';
import { SodViolationError, type SodRuleId } from '@ct/contracts';

export interface ActorRef {
  userId: string;
}

export interface CreatedRecord {
  createdBy: string | null;
}

export interface ReportedQuantity {
  reportedBy: string | null;
}

export interface ResolvedIssue {
  resolvedBy: string | null;
}

/**
 * Separation of duty — the three structural rules.
 *
 * These are FIXED IN CODE. There is no configuration path that disables them,
 * for any tenant, and no platform-staff override. `app.sod_policies` exists for
 * the configurable conflict PAIRS of Phase 2 and deliberately contains none of
 * these.
 *
 * They are enforced in the service layer, before the state machine, so a
 * refusal happens whether the action arrives from the API, a sync batch or a
 * background job.
 */
@Injectable()
export class SodService {
  /** SoD-01 — a user may never approve a record they created. */
  assertCanApprove(actor: ActorRef, record: CreatedRecord, detail?: string): void {
    if (record.createdBy && record.createdBy === actor.userId) {
      throw new SodViolationError('SoD-01', detail ?? 'you cannot approve a record you created');
    }
  }

  /** SoD-02 — a user may never verify a quantity they reported. */
  assertCanVerifyQuantity(actor: ActorRef, entry: ReportedQuantity, detail?: string): void {
    if (entry.reportedBy && entry.reportedBy === actor.userId) {
      throw new SodViolationError('SoD-02', detail ?? 'you cannot verify a quantity you reported');
    }
  }

  /** SoD-03 — a user may never verify or close an issue they resolved. */
  assertCanVerifyIssue(actor: ActorRef, issue: ResolvedIssue, detail?: string): void {
    if (issue.resolvedBy && issue.resolvedBy === actor.userId) {
      throw new SodViolationError(
        'SoD-03',
        detail ?? 'you cannot verify work you performed yourself',
      );
    }
  }

  /**
   * Non-throwing form, for the UI.
   *
   * The control must not be RENDERED when SoD would refuse it — greyed-out
   * controls advertise what a user cannot have and invite workarounds (FR-020).
   * The client asks this; the server still enforces the assert.
   */
  wouldRefuse(
    rule: SodRuleId,
    actorUserId: string,
    subjectUserId: string | null | undefined,
  ): boolean {
    void rule;
    return !!subjectUserId && subjectUserId === actorUserId;
  }
}
