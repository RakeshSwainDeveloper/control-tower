-- ═══════════════════════════════════════════════════════════════════
-- 0013_platform_metrics
--
-- The Super Admin tenant list showed user_count = 0 for every organization.
-- Not a query bug: RLS was doing its job. The aggregate ran without tenant
-- context, so app.users returned nothing to count.
--
-- FR-079a is the constraint: platform staff see SHAPES AND VOLUMES, never
-- record content. So this is not "let the platform read users" — it is a
-- function that can ONLY return counts. It cannot return a name, an email or
-- an id, because it does not select any.
--
-- Same fence as the auth resolvers: owned by ct_auth (NOLOGIN), EXECUTE
-- granted to the app role, column grants that admit counting and nothing more.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.org_metrics AS (
  org_id       uuid,
  user_count   integer,
  active_users integer,
  last_login   timestamptz
);

CREATE OR REPLACE FUNCTION app.platform_org_metrics()
RETURNS SETOF app.org_metrics
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  SELECT o.id,
         count(u.id)::int,
         count(u.id) FILTER (WHERE u.status = 'active')::int,
         max(u.last_login_at)
  FROM app.organizations o
  LEFT JOIN app.users u ON u.org_id = o.id
  GROUP BY o.id;
$$;

ALTER FUNCTION app.platform_org_metrics() OWNER TO ct_auth;
REVOKE ALL ON FUNCTION app.platform_org_metrics() FROM PUBLIC;

-- 'status' and 'last_login_at' are needed for the FILTER and the max();
-- 'id'/'org_id' for the join and the count. Nothing identifying is granted.
GRANT SELECT (id, org_id, status, last_login_at) ON app.users TO ct_auth;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.platform_org_metrics() TO %I', app_role);
END $$;

COMMENT ON FUNCTION app.platform_org_metrics() IS
  'Counts only. Returns no name, email or user id by construction, so it '
  'satisfies FR-079a: platform staff see volumes, never record content.';
