-- ═══════════════════════════════════════════════════════════════════
-- 0021_evidence   ·   PHASE 4 · M8
--
-- Evidence is what makes every other claim in the product defensible. It is
-- also the largest storage cost, the slowest thing on a 3G connection, and the
-- easiest thing to game. All three are addressed here.
--
-- Spec: MVP_SCOPE.md §4 M8 · FR-170..173, 175..180, 182, 183, 188, 189
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.evidence_kind AS ENUM ('photo', 'video', 'document', 'audio', 'signature');

CREATE TYPE app.capture_method AS ENUM ('in_app_camera', 'gallery', 'desktop_upload');

CREATE TYPE app.evidence_purpose AS ENUM (
  'progress', 'inspection', 'issue', 'closure', 'receipt',
  'safety', 'before', 'after', 'general'
);

CREATE TYPE app.evidence_state AS ENUM (
  'pending_upload',   -- presigned, bytes not yet confirmed
  'uploaded',         -- bytes present, awaiting processing
  'ready',            -- thumbnail generated, servable
  'failed',           -- processing failed; the row stays, the reason is visible
  'quarantined'       -- failed malware or content-type validation
);

-- ── Assets: the bytes and their provenance. IMMUTABLE. ─────────────
CREATE TABLE app.evidence_assets (
  id            UUID NOT NULL DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL,
  project_id    UUID,

  kind          app.evidence_kind NOT NULL,
  storage_key   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0),

  -- FR-173. Re-submitting last week's photo as today's progress is the most
  -- common form of evidence fraud on a site, and it is trivially detectable.
  -- One row per distinct byte sequence per tenant; links do the reuse.
  content_hash  BYTEA NOT NULL,

  -- Reserved for Phase 2 near-duplicate flagging (FR-174). Present so the
  -- backfill is a job, not a migration.
  perceptual_hash BYTEA,

  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,

  -- ── Capture context (FR-171). All of it, or the evidence is worth less. ──
  captured_at_device TIMESTAMPTZ NOT NULL,
  captured_at_server TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at        TIMESTAMPTZ,
  captured_by        UUID NOT NULL,
  -- FR-030: which responsibility was exercised, not merely who held the phone.
  captured_by_grant_id UUID,
  responsibility_label TEXT,
  capture_method     app.capture_method NOT NULL,

  gps_lat        NUMERIC(9,6),
  gps_lng        NUMERIC(9,6),
  gps_accuracy_m NUMERIC(8,2),
  -- FR-182: a missing fix is recorded WITH ITS REASON and never as 0,0.
  gps_unavailable_reason TEXT,

  device_model  TEXT,
  app_version   TEXT,
  -- A device with a wrong date is a common source of nonsense timestamps, so
  -- the skew is measured and kept rather than silently trusted.
  clock_skew_ms INTEGER,

  -- The original file's own timestamp, for the gallery age rule (BR-12).
  original_file_timestamp TIMESTAMPTZ,

  state          app.evidence_state NOT NULL DEFAULT 'pending_upload',
  state_reason   TEXT,
  thumbnail_key  TEXT,

  -- Offline origin, for the sync path.
  client_uuid    UUID,
  is_offline_origin BOOLEAN NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (id, captured_at_server),
  CONSTRAINT evidence_gps_or_reason CHECK (
    (gps_lat IS NOT NULL AND gps_lng IS NOT NULL)
    OR gps_unavailable_reason IS NOT NULL
    OR capture_method = 'desktop_upload'
  )
) PARTITION BY RANGE (captured_at_server);

COMMENT ON TABLE app.evidence_assets IS
  'IMMUTABLE once uploaded (FR-172). There is no edit and no replace: if a '
  'photo was wrong, a new one is added and the old one is UNLINKED with a '
  'reason. Partitioned monthly — 30k-80k rows/year on one project.';

CREATE UNIQUE INDEX evidence_assets_hash_key
  ON app.evidence_assets (org_id, content_hash, captured_at_server);
CREATE INDEX evidence_assets_project_idx
  ON app.evidence_assets (org_id, project_id, captured_at_server DESC);
CREATE INDEX evidence_assets_capturer_idx
  ON app.evidence_assets (org_id, captured_by, captured_at_server DESC);
CREATE INDEX evidence_assets_state_idx
  ON app.evidence_assets (org_id, state, captured_at_server)
  WHERE state IN ('pending_upload', 'uploaded', 'failed');
CREATE UNIQUE INDEX evidence_assets_client_uuid_key
  ON app.evidence_assets (org_id, client_uuid, captured_at_server)
  WHERE client_uuid IS NOT NULL;

ALTER TABLE app.evidence_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.evidence_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.evidence_assets
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- ── Links: one asset, many records. Soft-unlink only. ──────────────
-- Separating asset from link is what makes dedupe, reuse and before/after
-- pairing possible without duplicating bytes, and what makes "remove this
-- photo" a reversible, audited unlink rather than a deletion.
CREATE TABLE app.evidence_links (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES app.projects(id) ON DELETE CASCADE,
  evidence_id   UUID NOT NULL,

  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  purpose       app.evidence_purpose NOT NULL DEFAULT 'general',
  location_id   UUID REFERENCES app.locations(id) ON DELETE SET NULL,
  caption       TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,

  linked_by     UUID NOT NULL,
  linked_by_grant_id UUID,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- FR-172/183: unlink is a soft, reasoned, audited act. The file itself is
  -- retained for the audit retention period.
  unlinked_by   UUID,
  unlinked_at   TIMESTAMPTZ,
  unlink_reason TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT evidence_links_unlink_needs_reason CHECK (
    unlinked_at IS NULL OR (unlink_reason IS NOT NULL AND length(btrim(unlink_reason)) >= 3)
  )
);
CREATE INDEX evidence_links_entity_idx
  ON app.evidence_links (org_id, entity_type, entity_id)
  WHERE unlinked_at IS NULL;
CREATE INDEX evidence_links_evidence_idx ON app.evidence_links (org_id, evidence_id);
CREATE INDEX evidence_links_project_idx
  ON app.evidence_links (org_id, project_id, purpose, linked_at DESC)
  WHERE unlinked_at IS NULL;
-- FR-173: the same bytes must not be attached twice to the same record.
CREATE UNIQUE INDEX evidence_links_no_duplicate_on_record
  ON app.evidence_links (org_id, entity_type, entity_id, evidence_id)
  WHERE unlinked_at IS NULL;

ALTER TABLE app.evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.evidence_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.evidence_links
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

CREATE TRIGGER evidence_links_touch BEFORE UPDATE ON app.evidence_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ── Immutability, enforced by the database ─────────────────────────
-- The service layer could enforce this, but an import, a background job or a
-- future bulk path must not be able to route around it.
CREATE OR REPLACE FUNCTION app.evidence_assets_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only the processing pipeline's own fields may change after upload.
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.size_bytes  IS DISTINCT FROM OLD.size_bytes
     OR NEW.captured_at_device IS DISTINCT FROM OLD.captured_at_device
     OR NEW.captured_by IS DISTINCT FROM OLD.captured_by
     OR NEW.capture_method IS DISTINCT FROM OLD.capture_method
     OR NEW.gps_lat IS DISTINCT FROM OLD.gps_lat
     OR NEW.gps_lng IS DISTINCT FROM OLD.gps_lng THEN
    RAISE EXCEPTION
      'Evidence is immutable: % cannot be changed after capture. Add a new '
      'asset and unlink the old one with a reason.',
      CASE
        WHEN NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN 'content_hash'
        WHEN NEW.storage_key  IS DISTINCT FROM OLD.storage_key  THEN 'storage_key'
        WHEN NEW.size_bytes   IS DISTINCT FROM OLD.size_bytes   THEN 'size_bytes'
        WHEN NEW.captured_by  IS DISTINCT FROM OLD.captured_by  THEN 'captured_by'
        ELSE 'capture context'
      END
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_assets_immutable_guard
  BEFORE UPDATE ON app.evidence_assets
  FOR EACH ROW EXECUTE FUNCTION app.evidence_assets_immutable();

-- Partitions, secured at creation by app.ensure_month_partition (0004).
DO $$
DECLARE m DATE;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', now())::date - INTERVAL '1 month',
      date_trunc('month', now())::date + INTERVAL '3 months',
      INTERVAL '1 month')::date
  LOOP
    PERFORM app.ensure_month_partition('app.evidence_assets'::regclass, m);
  END LOOP;
END $$;
