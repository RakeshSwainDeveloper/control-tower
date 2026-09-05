-- ═══════════════════════════════════════════════════════════════════
-- 0006_identity_access   ·   PHASE 2 · M1 Tenancy & Identity, M2 Access
--
-- Spec: MVP_SCOPE.md §4 (M1, M2) · MVP_PERMISSION_MATRIX.md · FR-020..FR-049
--
-- The model, in one line:
--   User --holds--> RoleGrant(Role x Scope) --grants--> PermissionKeys
--   effective = UNION of grants covering the record
--             INTERSECT record-level qualifier
--             MINUS separation-of-duty refusals
-- ═══════════════════════════════════════════════════════════════════

-- ── Users ──────────────────────────────────────────────────────────
CREATE TABLE app.users (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  user_type     app.user_type NOT NULL DEFAULT 'internal',

  -- External-party binding. Present and NULL through the MVP so Phase 2's
  -- contractor/vendor logins are an addition, not a migration (FR-047).
  party_type    TEXT,
  party_id      UUID,

  password_hash TEXT,
  mfa_secret    TEXT,
  mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
  locale        TEXT NOT NULL DEFAULT 'en',
  status        TEXT NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','active','suspended','deactivated')),

  -- Bumped on ANY grant/role change. The compiled permission set is cached
  -- against this, so a stale client is detected rather than trusted (FR-021).
  permission_version INTEGER NOT NULL DEFAULT 1,

  last_login_at TIMESTAMPTZ,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT users_need_an_identifier CHECK (email IS NOT NULL OR phone IS NOT NULL),
  -- An external user must be bound to a party; an internal one must not be.
  CONSTRAINT users_party_binding CHECK (
    (user_type::text LIKE 'external%') = (party_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX users_org_email_key ON app.users (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_org_phone_key ON app.users (org_id, phone)        WHERE phone IS NOT NULL;
CREATE INDEX users_org_status_idx ON app.users (org_id, status);

COMMENT ON COLUMN app.users.permission_version IS
  'Incremented on any grant or role change. Cached permission sets carrying an '
  'older stamp are discarded rather than trusted.';

-- ── Invitations (FR-093, FR-094) ───────────────────────────────────
CREATE TABLE app.invitations (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  email         TEXT,
  phone         TEXT,
  name          TEXT NOT NULL,
  user_type     app.user_type NOT NULL DEFAULT 'internal',
  -- Only the hash is stored. A leaked table must not yield usable invites.
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES app.users(id),
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID,
  invited_by    UUID NOT NULL,
  -- Roles to grant on acceptance, as [{role_id, scope_type, scope_id}]
  pending_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  version       INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT invitations_need_an_identifier CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX invitations_org_idx ON app.invitations (org_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── Sessions (FR-562) ──────────────────────────────────────────────
CREATE TABLE app.user_sessions (
  id                 UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id             UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  -- Refresh tokens are stored hashed and ROTATED on every use. reused_at
  -- records a replay, which means the token leaked: the whole family dies.
  refresh_token_hash TEXT NOT NULL UNIQUE,
  parent_session_id  UUID REFERENCES app.user_sessions(id) ON DELETE SET NULL,
  device_id          TEXT,
  device_label       TEXT,
  user_agent         TEXT,
  ip                 INET,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,
  reused_at          TIMESTAMPTZ
);
CREATE INDEX user_sessions_user_idx ON app.user_sessions (org_id, user_id)
  WHERE revoked_at IS NULL;

-- ── OTP challenges (phone login for site users) ────────────────────
CREATE TABLE app.otp_challenges (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID REFERENCES app.organizations(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON app.otp_challenges (phone, created_at DESC);

-- ── Roles: tenant-defined bundles of code-defined keys (FR-022/024) ──
CREATE TABLE app.roles (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  -- A system role ships as seed data. It may be cloned and edited; it may not
  -- be deleted while granted.
  is_system   BOOLEAN NOT NULL DEFAULT false,
  is_external BOOLEAN NOT NULL DEFAULT false,
  applicable_scope_levels app.scope_type[] NOT NULL DEFAULT ARRAY['project']::app.scope_type[],
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

CREATE TABLE app.role_permissions (
  org_id           UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  role_id          UUID NOT NULL REFERENCES app.roles(id) ON DELETE CASCADE,
  -- FK to the code-defined catalogue: a role can never hold a key that no
  -- code checks (FR-022).
  permission_key   TEXT NOT NULL REFERENCES app.permission_keys(key) ON DELETE RESTRICT,
  record_qualifier app.record_qualifier NOT NULL DEFAULT 'all_in_scope',
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX role_permissions_org_idx ON app.role_permissions (org_id, role_id);

-- ── Role grants: the central access record (FR-021) ────────────────
CREATE TABLE app.role_grants (
  id         UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id     UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role_id    UUID NOT NULL REFERENCES app.roles(id) ON DELETE RESTRICT,
  scope_type app.scope_type NOT NULL,
  -- NULL only for org scope. 'company' is permitted by the enum but unused in
  -- the MVP, so Phase 2 multi-entity is a data change, not a migration.
  scope_id   UUID,

  -- What appears on every record this grant is exercised under.
  -- "Ramesh approved this" is ambiguous; "as Project Manager" is not (FR-030).
  responsibility_label TEXT NOT NULL,

  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to   TIMESTAMPTZ,
  granted_by UUID NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version    INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT role_grants_scope_shape CHECK (
    (scope_type = 'org' AND scope_id IS NULL) OR
    (scope_type <> 'org' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT role_grants_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX role_grants_user_idx  ON app.role_grants (org_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX role_grants_scope_idx ON app.role_grants (org_id, scope_type, scope_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX role_grants_unique_live
  ON app.role_grants (org_id, user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

COMMENT ON TABLE app.role_grants IS
  'Role x Scope x validity. Revoking a grant never alters records already '
  'created under it: the responsibility label is copied onto the record at '
  'write time (FR-028).';

-- ── Reserved for Phase 2/3, created empty so activation is data-only ──
CREATE TABLE app.approval_authorities (
  id UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  scope_type app.scope_type NOT NULL,
  scope_id UUID,
  amount_min BIGINT, amount_max BIGINT, currency CHAR(3),   -- no money in MVP
  is_delegable BOOLEAN NOT NULL DEFAULT false,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX approval_authorities_user_idx ON app.approval_authorities (org_id, user_id);

CREATE TABLE app.sod_policies (
  id UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  pair_code TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'flag' CHECK (mode IN ('block','flag','allow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, pair_code)
);
COMMENT ON TABLE app.sod_policies IS
  'Configurable conflict PAIRS. Unseeded in the MVP. The structural rules '
  'SoD-01..03 are fixed in code and appear nowhere in this table by design.';

-- ── Triggers ───────────────────────────────────────────────────────
CREATE TRIGGER users_touch          BEFORE UPDATE ON app.users          FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER invitations_touch    BEFORE UPDATE ON app.invitations    FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER roles_touch          BEFORE UPDATE ON app.roles          FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER role_grants_touch    BEFORE UPDATE ON app.role_grants    FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ── RLS on every one of them ───────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','invitations','user_sessions','otp_challenges','roles',
    'role_permissions','role_grants','approval_authorities','sod_policies'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- otp_challenges.org_id is nullable: a login attempt names a phone number
-- before we know which tenant it belongs to. That row is not tenant data until
-- resolved, so it needs a policy that admits the pre-tenant case explicitly
-- rather than by accident.
DROP POLICY tenant_isolation ON app.otp_challenges;
CREATE POLICY tenant_isolation ON app.otp_challenges
  USING (org_id IS NULL OR org_id = app.current_org_id())
  WITH CHECK (org_id IS NULL OR org_id = app.current_org_id());
COMMENT ON TABLE app.otp_challenges IS
  'org_id is nullable because a phone-login attempt precedes tenant resolution. '
  'The policy admits that case explicitly; it is not an oversight. Rows are '
  'short-lived and carry only a hashed code.';
