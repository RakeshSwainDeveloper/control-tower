import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

export interface TenantContext {
  orgId: string;
  userId?: string | undefined;
  /** The role grant being exercised — recorded on every row (FR-030). */
  grantId?: string | undefined;
}

export class MissingTenantContextError extends Error {
  constructor(where: string) {
    super(
      `No tenant context at ${where}. Every org-scoped query must run inside ` +
        `withTenant(). A job without tenant context must fail, not run unscoped.`,
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * Runs `fn` inside a transaction with the tenant context set ONCE.
 *
 * This is the only sanctioned way to touch org-scoped tables.
 * SET LOCAL is scoped to the transaction, which is why the pool MUST use
 * transaction-level pooling — session pooling would leak one tenant's context
 * into the next request, and that is the single most common way this pattern
 * is implemented wrongly. (SYSTEM_ARCHITECTURE.md §4.2)
 */
export async function withTenant<DB, T>(
  db: Kysely<DB>,
  ctx: TenantContext,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!ctx.orgId) throw new MissingTenantContextError('withTenant');

  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`.execute(trx);
    if (ctx.userId) {
      await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
    }
    if (ctx.grantId) {
      await sql`SELECT set_config('app.current_grant_id', ${ctx.grantId}, true)`.execute(trx);
    }
    return fn(trx);
  });
}

/**
 * Escape hatch for genuinely tenant-less work: platform tables, migrations,
 * partition maintenance. Named so it is obvious in review and greppable in CI.
 */
export async function withoutTenant<DB, T>(
  db: Kysely<DB>,
  reason: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  void reason;
  return db.transaction().execute(fn);
}
