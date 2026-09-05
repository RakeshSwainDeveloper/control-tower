-- ═══════════════════════════════════════════════════════════════════
-- 0001_foundation
-- Migration bookkeeping, tenancy primitives, and the RLS machinery
-- that every subsequent migration depends on.
--
-- Spec: MVP_DATABASE_SCOPE.md §§1,7 · SYSTEM_ARCHITECTURE.md §4
-- ═══════════════════════════════════════════════════════════════════

-- ── Migration bookkeeping ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.schema_migrations (
  version     TEXT PRIMARY KEY,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER     NOT NULL
);

-- ── UUID v7 ────────────────────────────────────────────────────────
-- Time-ordered (index locality) and non-enumerable. Postgres 16 has no
-- native uuidv7(), so we build one: 48-bit ms timestamp + version/variant
-- nibbles + random. Matches RFC 9562 layout.
CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  unix_ms  BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
  bytes    BYTEA  := gen_random_bytes(10);
BEGIN
  RETURN encode(
    -- 6 bytes timestamp
    substring(int8send(unix_ms) FROM 3 FOR 6)
    -- byte 7: version 7 in the high nibble
    || set_byte(substring(bytes FROM 1 FOR 1), 0,
                (get_byte(bytes, 0) & 15) | 112)
    || substring(bytes FROM 2 FOR 1)
    -- byte 9: variant 10xx in the two high bits
    || set_byte(substring(bytes FROM 3 FOR 1), 0,
                (get_byte(bytes, 2) & 63) | 128)
    || substring(bytes FROM 4 FOR 7),
    'hex')::uuid;
END $$;

COMMENT ON FUNCTION app.uuid_v7() IS
  'RFC 9562 UUIDv7. Time-ordered for index locality, non-enumerable. D-10.';

-- ── Tenant context helpers ─────────────────────────────────────────
-- Set ONCE per request/job via SET LOCAL. Never reconstructed per query.
-- A job without tenant context must FAIL, not run unscoped.
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_grant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_grant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app.current_org_id() IS
  'Tenant context for RLS. NULL when unset, which makes every RLS policy '
  'fail closed rather than leak. SYSTEM_ARCHITECTURE.md §4.2';

-- ── updated_at / version trigger ───────────────────────────────────
-- Optimistic concurrency: `version` backs If-Match / 409 handling.
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version    := COALESCE(OLD.version, 0) + 1;
  RETURN NEW;
END $$;

-- ── Enum types ─────────────────────────────────────────────────────
-- Mirrors packages/contracts/src/*.ts exactly. Values reserved for Phase 2
-- are present now so activating them needs no enum migration.
CREATE TYPE app.state_class AS ENUM (
  'draft','submitted','in_review','in_approval','approved','rejected',
  'in_progress','resolved','verified','closed','cancelled','on_hold','void'
);

CREATE TYPE app.scope_type AS ENUM ('org','company','project');

CREATE TYPE app.record_qualifier AS ENUM (
  'all_in_scope','own_created','assigned_to_me',
  'my_party','my_team','my_location_subtree'   -- reserved for Phase 2
);

CREATE TYPE app.user_type AS ENUM (
  'internal',
  'external_contractor','external_vendor',
  'external_consultant','external_client',      -- reserved for Phase 2
  'platform_staff'
);

CREATE TYPE app.org_status AS ENUM (
  'trial','active','past_due','suspended','read_only','closed'
);

-- ═══════════════════════════════════════════════════════════════════
-- PLATFORM TABLES — no org_id, no RLS. Reachable only from the
-- Super Admin surface with its own credentials. SUPER_ADMIN.md §1
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE app.permission_keys (
  key          TEXT PRIMARY KEY,
  module       TEXT        NOT NULL,
  resource     TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  description  TEXT,
  is_deprecated BOOLEAN    NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permission_keys_shape CHECK (key = module || '.' || resource || '.' || action)
);
COMMENT ON TABLE app.permission_keys IS
  'Code-defined catalogue (FR-022). Seeded from @ct/contracts. Keys are added, '
  'never silently removed (FR-064).';

CREATE TABLE app.platform_users (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  platform_role TEXT NOT NULL CHECK (platform_role IN ('platform_owner','platform_support')),
  mfa_secret    TEXT,
  mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE app.feature_flags (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID,                         -- NULL = platform-wide default
  flag_key    TEXT NOT NULL,
  is_enabled  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, flag_key)
);

-- ═══════════════════════════════════════════════════════════════════
-- TENANCY
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE app.organizations (
  id             UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  legal_name     TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  country        TEXT NOT NULL DEFAULT 'IN',
  currency       CHAR(3) NOT NULL DEFAULT 'INR',   -- declared; NO money in MVP
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locale         TEXT NOT NULL DEFAULT 'en',
  data_region    TEXT NOT NULL DEFAULT 'ap-south-1',  -- Q-25
  status         app.org_status NOT NULL DEFAULT 'trial',
  suspended_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  version        INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT organizations_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);
COMMENT ON TABLE app.organizations IS
  'The tenant and the hard data-isolation boundary (FR-002).';

-- Companies: one auto-created per org and hidden from the MVP UI (FR-003).
-- The table exists so Phase 2 multi-entity is additive.
CREATE TABLE app.companies (
  id           UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id       UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  tax_registration TEXT,
  address      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX companies_org_idx ON app.companies (org_id);
CREATE UNIQUE INDEX companies_one_default_per_org
  ON app.companies (org_id) WHERE is_default;

CREATE TRIGGER organizations_touch BEFORE UPDATE ON app.organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER companies_touch BEFORE UPDATE ON app.companies
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER platform_users_touch BEFORE UPDATE ON app.platform_users
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER feature_flags_touch BEFORE UPDATE ON app.feature_flags
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ── RLS on companies (organizations is reached by id, guarded in app) ──
ALTER TABLE app.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.companies
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
