-- ═══════════════════════════════════════════════════════════════════
-- 0009_auth_bootstrap_grants
--
-- BYPASSRLS bypasses the POLICY, not the GRANT. ct_auth owned the resolver
-- functions but held no privilege on app.users, so the definer context still
-- failed with "permission denied for table users".
--
-- Grants are COLUMN-LEVEL and cover exactly what the three functions read or
-- write — nothing else. If a future resolver needs another column, this
-- migration has to be extended deliberately, which is the point: the blast
-- radius of the one RLS-bypassing role stays visible in one place.
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT (
  id, org_id, email, phone, password_hash, status,
  permission_version, failed_logins, locked_until
) ON app.users TO ct_auth;

-- record_failed_login touches only the lockout counters.
GRANT UPDATE (failed_logins, locked_until) ON app.users TO ct_auth;

-- The resolvers join organizations to refuse a closed tenant.
GRANT SELECT (id, status) ON app.organizations TO ct_auth;

COMMENT ON FUNCTION app.resolve_login_by_email(text) IS
  'Authentication bootstrap only. Owned by ct_auth (NOLOGIN, BYPASSRLS) because '
  'login precedes tenant context and app.users uses FORCE RLS, which binds even '
  'the table owner. Column-level grants in migration 0009 confine what this '
  'role can see: exact match, one row, credential columns only.';
