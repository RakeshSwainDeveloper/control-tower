import type { Transaction } from 'kysely';
import type { DB } from '@ct/db';

export type ConflictPolicy = 'accept_as_new' | 'keep_both_and_flag' | 'reject_to_attention';
export type SyncStatus = 'accepted' | 'conflict' | 'rejected';

export interface SyncActor {
  userId: string;
  orgId: string;
  deviceId?: string | undefined;
  grantId?: string | undefined;
  responsibility?: string | undefined;
}

export interface SyncItem {
  client_uuid: string;
  entity: string;
  op: 'create' | 'update' | 'transition';
  payload: Record<string, unknown>;
  device_ts?: string;
  clock_skew_ms?: number;
  /** The version the device believed it was editing. Absent for creates. */
  base_version?: number;
}

export interface SyncResult {
  client_uuid: string;
  status: SyncStatus;
  server_id?: string | null;
  server_number?: string | null;
  version?: number | null;
  conflict?: {
    policy: ConflictPolicy;
    kept_both: boolean;
    other_id?: string | null;
    detail?: string;
  };
  reason?: string;
}

/**
 * Rejecting an item is a normal outcome, not a fault.
 *
 * The device's payload is preserved and surfaced in needs-attention so the user
 * can correct and resubmit without re-entering anything (FR-491). Throwing a
 * generic error instead would lose the payload and, with it, the user's work.
 */
export class SyncRejection extends Error {
  constructor(public readonly userMessage: string, public readonly detail?: Record<string, unknown>) {
    super(userMessage);
    this.name = 'SyncRejection';
  }
}

/** Raised when the record moved on while the device was offline. */
export class SyncConflict extends Error {
  constructor(
    public readonly policy: ConflictPolicy,
    public readonly userMessage: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(userMessage);
    this.name = 'SyncConflict';
  }
}

export interface AppliedItem {
  serverId: string;
  serverNumber?: string | null;
  version?: number | null;
  /** Set when the handler resolved a conflict rather than a clean apply. */
  conflict?: {
    policy: ConflictPolicy;
    keptBoth: boolean;
    otherId?: string | null;
    detail?: string;
  };
}

/**
 * One offline-capable entity's contribution to the sync engine.
 *
 * The engine owns idempotency, ordering, transactions, the needs-attention
 * queue and the audit trail. A handler owns only what its entity means.
 * Phase 5 registers progress entries and daily reports here without touching
 * the engine.
 */
export interface SyncHandler {
  readonly entity: string;
  /** Which policy applies when the server state has moved on. */
  readonly conflictPolicy: ConflictPolicy;
  /** Permission key the caller must hold to submit this entity. */
  readonly permission: string;
  apply(
    trx: Transaction<DB>,
    actor: SyncActor,
    item: SyncItem,
  ): Promise<AppliedItem>;
}
