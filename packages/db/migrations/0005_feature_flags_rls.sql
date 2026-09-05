-- ═══════════════════════════════════════════════════════════════════
-- 0005_feature_flags_rls
--
-- GAP: app.feature_flags carried an org_id but had RLS off and no policy.
-- Not exploitable while nothing read it, but FR-012 requires feature flags to
-- be evaluated SERVER-SIDE on every request, so Phase 2 reads this table
-- inside a tenant transaction. One query bug then leaks entitlement data
-- ("which modules does competitor X pay for") across tenants.
--
-- The real problem was conflating two different things in one table:
--   · the platform's CATALOGUE of flags        — not tenant data at all
--   · a tenant's OVERRIDE of one of them       — tenant data, needs RLS
--
-- A single table forces a policy like "org_id IS NULL OR org_id = current",
-- which means "no tenant context sees the platform rows" — a fail-OPEN branch
-- in the middle of the isolation model. Splitting removes the branch.
--
-- Super Admin still manages tenant overrides: it acts on one org at a time and
-- therefore sets tenant context like everything else. It has no reason to read
-- every tenant's flags at once (FR-079a).
-- ═══════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS app.feature_flags;   -- never read; no data to preserve

-- ── Platform catalogue: what flags exist. Not tenant data. ─────────
CREATE TABLE app.feature_flag_defs (
  flag_key        TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  default_enabled BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT feature_flag_defs_key_shape CHECK (flag_key ~ '^[a-z][a-z0-9_.]{2,63}$')
);
COMMENT ON TABLE app.feature_flag_defs IS
  'Platform-owned catalogue of feature flags. Contains no tenant data, so it '
  'carries no org_id and needs no RLS.';

-- ── Tenant overrides: org-scoped, RLS forced like every other tenant table ──
CREATE TABLE app.org_feature_flags (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  flag_key    TEXT NOT NULL REFERENCES app.feature_flag_defs(flag_key) ON DELETE CASCADE,
  is_enabled  BOOLEAN NOT NULL,
  set_by      UUID,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, flag_key)
);
CREATE INDEX org_feature_flags_org_idx ON app.org_feature_flags (org_id);

CREATE TRIGGER feature_flag_defs_touch BEFORE UPDATE ON app.feature_flag_defs
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER org_feature_flags_touch BEFORE UPDATE ON app.org_feature_flags
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

ALTER TABLE app.org_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.org_feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.org_feature_flags
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- Seed the MVP module catalogue. Everything a Phase 1 tenant needs is on;
-- deferred modules are declared but off, so Phase 2/3 turns them on rather
-- than adding rows under time pressure.
INSERT INTO app.feature_flag_defs (flag_key, description, default_enabled) VALUES
  ('module.field',        'Daily progress, quantity ledger, verification', true),
  ('module.evidence',     'Photo/video evidence capture and storage',      true),
  ('module.issues',       'Issues, actions, comments',                      true),
  ('module.approvals',    'Approval engine',                                true),
  ('module.dashboard',    'Dashboards and reporting',                       true),
  ('module.audit',        'Audit trail access',                             true),
  ('module.offline_sync', 'Offline outbox ingest',                          true),
  ('module.procurement',  'Procurement (Phase 3)',                          false),
  ('module.inventory',    'Materials and inventory (Phase 3)',              false),
  ('module.contracts',    'Contractor billing (Phase 3)',                   false),
  ('module.quality',      'Inspections and NCRs (Phase 2)',                 false),
  ('module.safety',       'Safety observations and incidents (Phase 2)',    false),
  ('module.documents',    'Document and drawing register (Phase 2)',        false),
  ('module.schedule',     'Milestones and activities (Phase 2)',            false)
ON CONFLICT (flag_key) DO NOTHING;
