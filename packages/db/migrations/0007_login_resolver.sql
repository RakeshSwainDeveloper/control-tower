-- ═══════════════════════════════════════════════════════════════════
-- 0007_login_resolver
--
-- THE BOOTSTRAP PROBLEM. Authentication must resolve the tenant FROM the
-- identifier, so it has to read app.users before any tenant context exists.
-- But app.users has FORCE ROW LEVEL SECURITY, so an unscoped read correctly
-- returns nothing — and login is impossible.
--
-- The tempting fix is a policy branch like "org_id IS NULL OR org_id =
-- current". That is fail-OPEN: any code path that forgets to set context then
-- reads every tenant's users. It is the same mistake that shipped in
-- feature_flags and was removed in 0005. Not repeating it.
--
-- Instead: a deliberately narrow SECURITY DEFINER resolver.
--   · EXACT match only — no LIKE, no prefix, no wildcard, so it cannot enumerate
--   · returns AT MOST ONE row, via the same unique indexes login relies on
--   · returns ONLY the columns authentication needs — not the user row
--   · no name, no email echo: nothing that turns it into a lookup oracle
-- Everything else about a user still requires tenant context.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.login_identity AS (
  user_id            uuid,
  org_id             uuid,
  password_hash      text,
  status             text,
  permission_version integer,
  failed_logins      integer,
  locked_until       timestamptz
);

CREATE OR REPLACE FUNCTION app.resolve_login_by_email(p_email text)
RETURNS app.login_identity
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  SELECT u.id, u.org_id, u.password_hash, u.status,
         u.permission_version, u.failed_logins, u.locked_until
  FROM app.users u
  JOIN app.organizations o ON o.id = u.org_id
  WHERE lower(u.email) = lower(p_email)
    -- A closed tenant cannot authenticate. Suspended tenants still can:
    -- suspension restricts creation, never read access (BR-27).
    AND o.status <> 'closed'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.resolve_login_by_phone(p_phone text)
RETURNS app.login_identity
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  SELECT u.id, u.org_id, u.password_hash, u.status,
         u.permission_version, u.failed_logins, u.locked_until
  FROM app.users u
  JOIN app.organizations o ON o.id = u.org_id
  WHERE u.phone = p_phone
    AND o.status <> 'closed'
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_login_by_email(text) IS
  'Authentication bootstrap only. SECURITY DEFINER because login precedes '
  'tenant context. Exact match, single row, minimal columns: it cannot be '
  'used to enumerate or to read user data.';

REVOKE ALL ON FUNCTION app.resolve_login_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_login_by_phone(text) FROM PUBLIC;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_login_by_email(text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_login_by_phone(text) TO %I', app_role);
END $$;

-- ── Failed-login counter, same bootstrap problem ────────────────────
-- Recording a failed attempt happens before authentication succeeds, so it
-- cannot run under tenant context either. Narrowed to exactly that job.
CREATE OR REPLACE FUNCTION app.record_failed_login(
  p_user_id uuid, p_max_attempts int, p_lock_minutes int
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  UPDATE app.users
  SET failed_logins = failed_logins + 1,
      locked_until = CASE
        WHEN failed_logins + 1 >= p_max_attempts
        THEN now() + make_interval(mins => p_lock_minutes)
        ELSE locked_until END
  WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION app.record_failed_login(uuid, int, int) FROM PUBLIC;
DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.record_failed_login(uuid, int, int) TO %I', app_role);
END $$;
