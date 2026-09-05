/**
 * The authentication bootstrap, and its blast radius.
 *
 * Login must read app.users BEFORE tenant context exists, but every tenant
 * table uses FORCE RLS — which binds the table owner too. The answer is a
 * single NOLOGIN, BYPASSRLS role (ct_auth) owning a handful of exact-match
 * resolver functions with column-level grants.
 *
 * That role is the one deliberate hole in the isolation model, so these tests
 * assert its shape rather than trusting the migrations stayed narrow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { withoutTenant, type DB } from '@ct/db';
import { appDb } from './helpers.js';

describe('auth bootstrap privileges', () => {
  let db: Kysely<DB>;
  beforeAll(() => { db = appDb(); });
  afterAll(async () => { await db.destroy(); });

  it('ct_auth cannot log in', async () => {
    const row = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ rolcanlogin: boolean; rolbypassrls: boolean }>`
        SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'ct_auth'
      `.execute(trx);
      return r.rows[0];
    });
    expect(row, 'ct_auth role is missing').toBeDefined();
    // BYPASSRLS is the point of the role; NOLOGIN is what makes it safe.
    expect(row!.rolbypassrls).toBe(true);
    expect(row!.rolcanlogin, 'ct_auth must never be able to open a session').toBe(false);
  });

  it('ct_auth owns ONLY the resolver functions', async () => {
    const owned = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ obj: string }>`
        SELECT p.proname AS obj FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE r.rolname = 'ct_auth' AND n.nspname = 'app'
        UNION ALL
        SELECT c.relname FROM pg_class c
        JOIN pg_roles r ON r.oid = c.relowner
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE r.rolname = 'ct_auth' AND n.nspname = 'app'
      `.execute(trx);
      return r.rows.map((x) => x.obj).sort();
    });
    // If this list grows, the bypass has widened and somebody must justify it
    // HERE, in this comment, before the test goes green again.
    //
    //  resolve_login_by_email/phone  — login precedes tenant context
    //  resolve_session_by_token      — refresh presents only an opaque token
    //  resolve_invitation_by_token   — an invitee is not yet a user
    //  record_failed_login           — lockout counter, pre-authentication
    //  platform_org_metrics          — NOT authentication: Super Admin volume
    //                                  counts. Returns counts only, never a
    //                                  name, email or user id (FR-079a).
    expect(owned).toEqual([
      'platform_org_metrics',
      'record_failed_login',
      'resolve_invitation_by_token',
      'resolve_login_by_email',
      'resolve_login_by_phone',
      'resolve_session_by_token',
    ]);
  });

  it('ct_auth holds COLUMN-level grants, not whole-table access', async () => {
    const cols = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      // information_schema.column_privileges only shows rows where the CURRENT
      // user is grantor or grantee, so it reports nothing here. Read the raw
      // ACLs instead.
      const r = await sql<{ table_name: string; column_name: string; privilege_type: string }>`
        SELECT c.relname AS table_name,
               a.attname AS column_name,
               acl.privilege_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
        JOIN pg_roles g ON g.oid = acl.grantee
        WHERE n.nspname = 'app' AND g.rolname = 'ct_auth'
        ORDER BY c.relname, acl.privilege_type, a.attname
      `.execute(trx);
      return r.rows;
    });
    expect(cols.length).toBeGreaterThan(0);

    // It must not be able to read a password reset path, an org's business
    // data, or anything outside the three tables authentication touches.
    const tables = new Set(cols.map((c) => c.table_name));
    expect([...tables].sort()).toEqual(
      ['invitations', 'organizations', 'user_sessions', 'users'],
    );

    // Writes are confined to the lockout counters.
    const writable = cols.filter((c) => c.privilege_type === 'UPDATE').map((c) => c.column_name).sort();
    expect(writable).toEqual(['failed_logins', 'locked_until']);
  });

  it('platform_org_metrics can only ever return counts', async () => {
    // It is the one ct_auth function that is not authentication, so its
    // narrowness has to come from its return TYPE rather than from LIMIT 1.
    // If it could return a name or an email, FR-079a would be violated by a
    // function the platform surface calls on every page load.
    const fields = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ attname: string }>`
        SELECT a.attname FROM pg_type t
        JOIN pg_class c ON c.oid = t.typrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
        WHERE t.typname = 'org_metrics'
        ORDER BY a.attnum
      `.execute(trx);
      return r.rows.map((x) => x.attname);
    });
    expect(fields).toEqual(['org_id', 'user_count', 'active_users', 'last_login']);
    for (const f of fields) {
      expect(['name', 'email', 'phone', 'user_id', 'password_hash']).not.toContain(f);
    }
  });

  it('the resolvers are exact-match and return at most one row', async () => {
    // A prefix or wildcard would turn the bypass into an enumeration oracle.
    const src = await withoutTenant(db, 'catalogue inspection', async (trx) => {
      const r = await sql<{ prosrc: string }>`
        SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname LIKE 'resolve\\_%'
      `.execute(trx);
      return r.rows.map((x) => x.prosrc);
    });
    expect(src.length).toBeGreaterThanOrEqual(4);
    for (const body of src) {
      expect(body.toUpperCase()).toContain('LIMIT 1');
      expect(body.toUpperCase(), 'no pattern matching in a bypass function').not.toContain(' LIKE ');
      expect(body).not.toContain('%');
    }
  });

  it('a normal app query on users is still blocked without tenant context', async () => {
    // The bypass must not have leaked into ordinary access.
    const rows = await withoutTenant(db, 'leak probe', (trx) =>
      trx.selectFrom('app.users').selectAll().execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('sessions are equally invisible without tenant context', async () => {
    const rows = await withoutTenant(db, 'leak probe', (trx) =>
      trx.selectFrom('app.user_sessions').selectAll().execute(),
    );
    expect(rows).toHaveLength(0);
  });
});
