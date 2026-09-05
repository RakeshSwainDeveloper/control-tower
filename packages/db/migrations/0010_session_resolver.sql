-- ═══════════════════════════════════════════════════════════════════
-- 0010_session_resolver
--
-- Refresh has the same bootstrap shape as login: the only thing the client
-- presents is an opaque token, so the tenant must be resolved FROM it before
-- any scoped query can run. app.user_sessions uses FORCE RLS, so the unscoped
-- read returned nothing and every refresh failed.
--
-- Same answer as 0007/0008: one narrow ct_auth-owned function, exact match on
-- the unique token hash, returning only what refresh needs to decide.
--
-- Refresh tokens stay OPAQUE rather than becoming JWTs. A self-describing
-- refresh token would remove this function, but it would also be unrevocable
-- until expiry — and reuse detection depends on us controlling the row.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.session_identity AS (
  session_id uuid,
  org_id     uuid,
  user_id    uuid,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE OR REPLACE FUNCTION app.resolve_session_by_token(p_token_hash text)
RETURNS app.session_identity
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  SELECT s.id, s.org_id, s.user_id, s.expires_at, s.revoked_at
  FROM app.user_sessions s
  WHERE s.refresh_token_hash = p_token_hash
  LIMIT 1;
$$;

ALTER FUNCTION app.resolve_session_by_token(text) OWNER TO ct_auth;
REVOKE ALL ON FUNCTION app.resolve_session_by_token(text) FROM PUBLIC;

GRANT SELECT (id, org_id, user_id, refresh_token_hash, expires_at, revoked_at)
  ON app.user_sessions TO ct_auth;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_session_by_token(text) TO %I', app_role);
END $$;

COMMENT ON FUNCTION app.resolve_session_by_token(text) IS
  'Refresh bootstrap. Resolves the tenant from an opaque token hash so the rest '
  'of the refresh path can run under normal tenant context.';
