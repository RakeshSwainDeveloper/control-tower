-- ═══════════════════════════════════════════════════════════════════
-- 0008_auth_bootstrap_owner
--
-- 0007 made the login resolvers SECURITY DEFINER, which was necessary but not
-- sufficient: app.users uses FORCE ROW LEVEL SECURITY, and FORCE binds the
-- table OWNER as well. Running as ct_migrator therefore still returned zero
-- rows and login stayed impossible.
--
-- The bypass is confined to ct_auth: a role that CANNOT LOG IN and owns
-- nothing but these three functions. ct_app holds EXECUTE and nothing more, so
-- it can run exactly these fixed single-row queries and no other SQL as ct_auth.
--
-- The alternative — relaxing the policy on app.users, or a
-- current_setting()-gated escape hatch — would be fail-open, and any code path
-- that forgot to set tenant context would read every tenant's users.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ct_auth') THEN
    RAISE EXCEPTION
      'Role ct_auth is missing. It is created by infra/postgres/init and needs '
      'superuser (BYPASSRLS). Recreate the database volume, or create it by hand.';
  END IF;
END $$;

ALTER FUNCTION app.resolve_login_by_email(text)          OWNER TO ct_auth;
ALTER FUNCTION app.resolve_login_by_phone(text)          OWNER TO ct_auth;
ALTER FUNCTION app.record_failed_login(uuid, int, int)   OWNER TO ct_auth;

-- Re-assert the grants: ALTER OWNER resets nothing, but being explicit here
-- means the whole privilege story for these functions is in one place.
REVOKE ALL ON FUNCTION app.resolve_login_by_email(text)        FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_login_by_phone(text)        FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_failed_login(uuid, int, int) FROM PUBLIC;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_login_by_email(text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_login_by_phone(text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.record_failed_login(uuid, int, int) TO %I', app_role);
END $$;
