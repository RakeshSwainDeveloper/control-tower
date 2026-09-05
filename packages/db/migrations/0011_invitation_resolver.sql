-- ═══════════════════════════════════════════════════════════════════
-- 0011_invitation_resolver
--
-- Accepting an invitation is the third bootstrap case, after login (0007) and
-- refresh (0010): the invitee is not yet a user, holds no session, and presents
-- only an opaque token. The tenant has to be resolved FROM that token.
--
-- Same fence as the others: one exact-match, single-row, ct_auth-owned
-- function with column-level grants. Adding it here rather than widening any
-- existing resolver keeps each function's purpose readable at a glance.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.invitation_identity AS (
  invitation_id  uuid,
  org_id         uuid,
  name           text,
  email          text,
  phone          text,
  expires_at     timestamptz,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  pending_grants jsonb
);

CREATE OR REPLACE FUNCTION app.resolve_invitation_by_token(p_token_hash text)
RETURNS app.invitation_identity
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
  SELECT i.id, i.org_id, i.name, i.email, i.phone,
         i.expires_at, i.accepted_at, i.revoked_at, i.pending_grants
  FROM app.invitations i
  JOIN app.organizations o ON o.id = i.org_id
  WHERE i.token_hash = p_token_hash
    AND o.status <> 'closed'
  LIMIT 1;
$$;

ALTER FUNCTION app.resolve_invitation_by_token(text) OWNER TO ct_auth;
REVOKE ALL ON FUNCTION app.resolve_invitation_by_token(text) FROM PUBLIC;

GRANT SELECT (
  id, org_id, name, email, phone, token_hash,
  expires_at, accepted_at, revoked_at, pending_grants
) ON app.invitations TO ct_auth;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_invitation_by_token(text) TO %I', app_role);
END $$;

COMMENT ON FUNCTION app.resolve_invitation_by_token(text) IS
  'Invitation-acceptance bootstrap. Resolves the tenant from an opaque token so '
  'the rest of acceptance runs under normal tenant context.';
