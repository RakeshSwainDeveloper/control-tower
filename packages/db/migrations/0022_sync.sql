-- ═══════════════════════════════════════════════════════════════════
-- 0022_sync   ·   PHASE 4 · M12c
--
-- Site connectivity is the constraint that shapes the whole product. An app
-- that requires connectivity is an app that gets used in the site office at
-- 8pm from memory — which is exactly the data-quality problem this system
-- exists to solve.
--
-- Built BEFORE the first mobile write path (MVP_MODULE_MAP.md §3). Retrofitting
-- an outbox into forty write endpoints costs more than building all forty.
--
-- Spec: FR-484..495 · MVP_WORKFLOWS.md §W7
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.sync_status AS ENUM ('accepted', 'conflict', 'rejected');

CREATE TYPE app.conflict_policy AS ENUM (
  -- Independent creates never conflict: two supervisors recording different
  -- work in different flats are not in disagreement about anything.
  'accept_as_new',
  -- Same logical record, two authors: keep BOTH and flag. Never pick a winner.
  'keep_both_and_flag',
  -- The record moved on while the device was offline. Reject to the
  -- needs-attention queue WITH THE ORIGINAL PAYLOAD, never discard.
  'reject_to_attention'
);

-- ── The idempotency ledger ─────────────────────────────────────────
-- One row per client-generated operation. Replaying an operation returns the
-- ORIGINAL result rather than performing it again, which is what makes a flaky
-- connection safe: without this, every retry duplicates data.
CREATE TABLE app.sync_operations (
  id             UUID NOT NULL DEFAULT app.uuid_v7(),
  org_id         UUID NOT NULL,
  user_id        UUID NOT NULL,
  device_id      TEXT,

  -- THE idempotency key. Generated on the device, before the first attempt.
  client_uuid    UUID NOT NULL,

  entity_type    TEXT NOT NULL,
  operation      TEXT NOT NULL CHECK (operation IN ('create', 'update', 'transition')),

  -- The payload is retained so a rejected item can be corrected and resubmitted
  -- without the user re-entering anything (FR-491).
  payload        JSONB NOT NULL,

  device_ts      TIMESTAMPTZ,
  clock_skew_ms  INTEGER,
  base_version   INTEGER,

  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  status         app.sync_status NOT NULL,
  server_entity_id UUID,
  server_number  TEXT,
  result         JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason         TEXT,

  -- Set when the item lands in needs-attention; cleared when the user resolves it.
  needs_attention BOOLEAN NOT NULL DEFAULT false,
  resolved_at    TIMESTAMPTZ,
  resolved_by    UUID,

  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

COMMENT ON TABLE app.sync_operations IS
  'Idempotency ledger. UNIQUE on (org_id, client_uuid): a replay returns the '
  'original result instead of duplicating the work. Payloads are kept for 90 '
  'days so a rejected item can be corrected without re-entry.';

CREATE UNIQUE INDEX sync_operations_client_uuid_key
  ON app.sync_operations (org_id, client_uuid, received_at);
CREATE INDEX sync_operations_attention_idx
  ON app.sync_operations (org_id, user_id, received_at DESC)
  WHERE needs_attention AND resolved_at IS NULL;
CREATE INDEX sync_operations_device_idx
  ON app.sync_operations (org_id, device_id, received_at DESC);

ALTER TABLE app.sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sync_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_operations
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- ── Conflicts, recorded rather than resolved away ──────────────────
CREATE TABLE app.sync_conflicts (
  id              UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id          UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id      UUID,
  sync_client_uuid UUID NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  policy_applied  app.conflict_policy NOT NULL,
  kept_both       BOOLEAN NOT NULL DEFAULT false,
  other_entity_id UUID,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  flagged_for_user_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  resolution      TEXT
);
CREATE INDEX sync_conflicts_open_idx
  ON app.sync_conflicts (org_id, project_id, created_at DESC)
  WHERE reviewed_at IS NULL;

ALTER TABLE app.sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sync_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_conflicts
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- ── Pull cursors, per device per entity ────────────────────────────
CREATE TABLE app.sync_cursors (
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  device_id   TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  cursor      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, device_id, entity_type)
);
ALTER TABLE app.sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sync_cursors
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

DO $$
DECLARE m DATE;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', now())::date - INTERVAL '1 month',
      date_trunc('month', now())::date + INTERVAL '3 months',
      INTERVAL '1 month')::date
  LOOP
    PERFORM app.ensure_month_partition('app.sync_operations'::regclass, m);
  END LOOP;
END $$;
