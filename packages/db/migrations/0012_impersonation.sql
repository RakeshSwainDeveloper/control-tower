-- ═══════════════════════════════════════════════════════════════════
-- 0012_impersonation   ·   PHASE 2 · M3 Super Admin
--
-- Support impersonation is the highest-risk capability in the platform
-- (SUPER_ADMIN.md §6). It must be possible — support without it is guesswork
-- over screenshots — and it must be impossible to do quietly.
--
-- MVP: READ-ONLY, time-boxed, reason required, dual-logged. The write path
-- with second-person approval is Phase 3.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE app.impersonation_sessions (
  id               UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  platform_user_id UUID NOT NULL REFERENCES app.platform_users(id),
  target_org_id    UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  target_user_id   UUID NOT NULL,
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),
  -- MVP is read-only. The column exists so enabling writes in Phase 3 is a
  -- data change plus an approval flow, not a migration.
  allow_writes     BOOLEAN NOT NULL DEFAULT false,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  ended_reason     TEXT,
  ip               INET,
  CONSTRAINT impersonation_is_time_boxed CHECK (expires_at > started_at)
);
CREATE INDEX impersonation_active_idx
  ON app.impersonation_sessions (target_org_id, expires_at)
  WHERE ended_at IS NULL;
CREATE INDEX impersonation_platform_user_idx
  ON app.impersonation_sessions (platform_user_id, started_at DESC);

COMMENT ON TABLE app.impersonation_sessions IS
  'Read-only, time-boxed support access. Every session writes to BOTH the '
  'platform audit stream and the tenant''s own audit_log, so a customer can see '
  'what we did inside their account without asking us (FR-510).';

-- No RLS: this is platform data about tenants, not tenant data. It is reachable
-- only from the Super Admin surface, which authenticates separately.
