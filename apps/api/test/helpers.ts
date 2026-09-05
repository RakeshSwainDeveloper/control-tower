import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createDb, withTenant, withoutTenant, type DB } from '@ct/db';
import { loadEnv } from '../src/config/env.js';

export const env = loadEnv();

/** App-role connection. RLS applies to it — that is the whole point. */
export function appDb(): Kysely<DB> {
  return createDb({ connectionString: env.DATABASE_URL, poolMax: 4 });
}

/** Migrator-role connection, for fixtures. Still subject to FORCE RLS. */
export function migratorDb(): Kysely<DB> {
  return createDb({
    connectionString: env.DATABASE_URL.replace(/\/\/([^:]+):/, '//ct_migrator:'),
    poolMax: 4,
  });
}

export interface Tenant { orgId: string; slug: string; companyId: string }

export async function createTenant(db: Kysely<DB>, label: string): Promise<Tenant> {
  const slug = `test-${label}-${randomUUID().slice(0, 8)}`;
  const org = await withoutTenant(db, 'creating a tenant precedes tenant context', (trx) =>
    trx
      .insertInto('app.organizations')
      .values({ legal_name: `${label} Pvt Ltd`, display_name: label, slug })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  const company = await withTenant(db, { orgId: org.id }, (trx) =>
    trx
      .insertInto('app.companies')
      .values({ org_id: org.id, name: `${label} Default`, is_default: true })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return { orgId: org.id, slug, companyId: company.id };
}

export async function dropTenant(db: Kysely<DB>, orgId: string): Promise<void> {
  // SET LOCAL takes no bind parameters; set_config() is the parameterised form.
  // withTenant already does this correctly — reuse it rather than hand-rolling.
  await withTenant(db, { orgId }, (trx) =>
    trx.deleteFrom('app.companies').where('org_id', '=', orgId).execute(),
  );
  // audit_log rows are deliberately NOT removed: the app role holds no DELETE
  // grant, by design (FR-502). There is no FK from audit_log to organizations,
  // so the org row still deletes cleanly and the trail survives the tenant.
  await withoutTenant(db, 'test teardown: organizations predates tenant context', (trx) =>
    trx.deleteFrom('app.organizations').where('id', '=', orgId).execute(),
  );
}
