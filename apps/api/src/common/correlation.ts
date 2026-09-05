import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  /** Populated by the auth guard once the request is authenticated. */
  orgId?: string;
  userId?: string;
  /** The role grant being exercised — copied onto every record (FR-030). */
  grantId?: string;
  responsibilityLabel?: string;
  source?: 'web' | 'mobile' | 'api' | 'sync' | 'job' | 'impersonation' | 'system';
  ip?: string;
  deviceId?: string;
  appVersion?: string;
}

/** Merge fields into the ambient context, e.g. after authentication. */
export function enrichContext(patch: Partial<RequestContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: Partial<RequestContext>, fn: () => T): T {
  return als.run({ correlationId: ctx.correlationId ?? randomUUID(), ...ctx }, fn);
}

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

export function correlationId(): string {
  return als.getStore()?.correlationId ?? 'no-context';
}

/** Short, human-quotable reference printed in every error response (NFR-17). */
export function supportReference(): string {
  return correlationId().replace(/-/g, '').slice(0, 12).toUpperCase();
}
