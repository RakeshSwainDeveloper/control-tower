-- ═══════════════════════════════════════════════════════════════════
-- 0023_progress   ·   PHASE 5 · M6 + M7
--
-- THE STRUCTURAL DECISION (PRODUCT_REVIEW.md §9.1, change C-2):
--
--   The reference FRD made the DAILY REPORT the container, with work lines
--   inside it, filled once at the end of the day. On a real site that form is
--   completed at 8pm in the site office, from memory — and photographs taken
--   at 11am get attached to a quantity recalled nine hours later. That defeats
--   the entire evidence proposition.
--
--   So: the PROGRESS ENTRY is the atomic record, captured AT the location, in
--   the moment. The DAILY REPORT is a thin header that collects the day's
--   entries and locks them on submission.
--
-- Consequences, all favourable: field capture is 3 fields and a camera rather
-- than a 5-step wizard; the GPS fix means something; the engineer can verify
-- during the day instead of waiting for an 8pm submission; and offline is
-- simpler, because entries are independent creates that never conflict.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.verification_status AS ENUM ('reported', 'verified', 'adjusted', 'rejected');

CREATE TYPE app.quantity_source AS ENUM (
  'daily_report',   -- a supervisor's progress claim
  'measurement',    -- contractor measurement for billing (Phase 3)
  'adjustment',     -- a correction, always with a reason
  'import'
);

-- ── Daily report: a THIN header, not a container ───────────────────
CREATE TABLE app.daily_reports (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  report_date   DATE NOT NULL,
  report_number TEXT,

  weather       TEXT,
  work_start    TIME,
  work_stop     TIME,
  -- FR-150 made OPTIONAL for the MVP: nothing consumes headcount until
  -- productivity reporting arrives, and data entry with no return to the user
  -- violates AR-01. Pre-filled from yesterday, skippable in one tap.
  manpower      JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes         TEXT,

  status_id     UUID REFERENCES app.statuses(id),
  state_class   app.state_class NOT NULL DEFAULT 'draft',

  submitted_at  TIMESTAMPTZ,
  submitted_by  UUID,
  submitted_by_grant_id UUID,
  locked_at     TIMESTAMPTZ,

  -- FR-144 / BR-10: a submitted report is never edited. A correction is an
  -- AMENDMENT that stands alongside the original, and both appear on the
  -- timeline in sequence.
  amends_report_id UUID REFERENCES app.daily_reports(id) ON DELETE RESTRICT,
  amendment_reason TEXT,

  -- Set when two supervisors submitted for the same day from offline devices.
  -- Neither is discarded; the PM sees both (conflict policy keep_both_and_flag).
  merged_from_report_id UUID REFERENCES app.daily_reports(id) ON DELETE SET NULL,
  has_merge_conflict BOOLEAN NOT NULL DEFAULT false,

  client_uuid   UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  created_by_grant_id UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT daily_reports_amendment_needs_reason CHECK (
    amends_report_id IS NULL OR
    (amendment_reason IS NOT NULL AND length(btrim(amendment_reason)) >= 5)
  )
);

-- One ORIGINAL report per project per day. Amendments and merge-conflict
-- twins are deliberately exempt: both must be able to exist alongside it.
CREATE UNIQUE INDEX daily_reports_one_original_per_day
  ON app.daily_reports (org_id, project_id, report_date)
  WHERE amends_report_id IS NULL AND merged_from_report_id IS NULL;
CREATE INDEX daily_reports_project_date_idx
  ON app.daily_reports (org_id, project_id, report_date DESC);
CREATE INDEX daily_reports_open_idx
  ON app.daily_reports (org_id, project_id, state_class)
  WHERE state_class IN ('draft', 'submitted', 'in_approval');
CREATE UNIQUE INDEX daily_reports_client_uuid_key
  ON app.daily_reports (org_id, client_uuid) WHERE client_uuid IS NOT NULL;

-- ── Progress entry: THE atomic record ──────────────────────────────
CREATE TABLE app.progress_entries (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,

  -- NULL until the day is submitted. An entry exists on its own from the
  -- moment it is captured; the report collects it later.
  daily_report_id UUID REFERENCES app.daily_reports(id) ON DELETE SET NULL,

  work_item_id  UUID NOT NULL,
  location_id   UUID NOT NULL,

  -- ── C-3: reported and verified are SEPARATE PERSISTED COLUMNS. ──
  -- The claim is never overwritten by an adjustment. "Reported 14, verified 11"
  -- must both survive: the gap between them is the signal the whole product is
  -- built on (FR-146), and an adjustment that erased the claim would erase it.
  reported_qty  NUMERIC(18,4) NOT NULL CHECK (reported_qty > 0),
  verified_qty  NUMERIC(18,4) CHECK (verified_qty >= 0),

  unit_id       UUID NOT NULL REFERENCES app.units(id) ON DELETE RESTRICT,
  executed_on   DATE NOT NULL,
  -- A label, not a login: contractors get accounts in Phase 2.
  contractor_label TEXT,
  note          TEXT,

  reported_by   UUID NOT NULL,
  reported_by_grant_id UUID,
  reported_responsibility TEXT,
  reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  verification_status app.verification_status NOT NULL DEFAULT 'reported',
  verified_by   UUID,
  verified_by_grant_id UUID,
  verified_responsibility TEXT,
  verified_at   TIMESTAMPTZ,
  verification_reason TEXT,

  -- FR-157 / VR-02: recording more than was planned is permitted, flagged and
  -- reasoned. Blocking it would mean the site simply stops recording.
  is_over_execution BOOLEAN NOT NULL DEFAULT false,
  over_execution_reason TEXT,

  client_uuid   UUID,
  is_offline_origin BOOLEAN NOT NULL DEFAULT false,
  device_clock_skew_ms INTEGER,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  -- An adjustment or rejection must say why. "Verified at 11 instead of 14"
  -- with no reason is an argument waiting to happen.
  CONSTRAINT progress_adjust_needs_reason CHECK (
    verification_status NOT IN ('adjusted', 'rejected')
    OR (verification_reason IS NOT NULL AND length(btrim(verification_reason)) >= 3)
  ),
  CONSTRAINT progress_verified_has_qty CHECK (
    verification_status <> 'verified' OR verified_qty IS NOT NULL
  ),
  CONSTRAINT progress_over_execution_needs_reason CHECK (
    NOT is_over_execution
    OR (over_execution_reason IS NOT NULL AND length(btrim(over_execution_reason)) >= 3)
  ),
  -- Cross-project integrity, the lesson of migration 0019: RLS confines a row
  -- to the tenant, not to the project.
  CONSTRAINT progress_work_item_same_project
    FOREIGN KEY (project_id, work_item_id) REFERENCES app.work_items (project_id, id)
    ON DELETE CASCADE,
  CONSTRAINT progress_location_same_project
    FOREIGN KEY (project_id, location_id) REFERENCES app.locations (project_id, id)
    ON DELETE CASCADE
);

CREATE INDEX progress_project_date_idx
  ON app.progress_entries (org_id, project_id, executed_on DESC);
CREATE INDEX progress_work_location_idx
  ON app.progress_entries (org_id, project_id, work_item_id, location_id);
-- The verification queue: an engineer's whole working list. Partial, so the
-- index stays small and hot as verified entries accumulate behind it.
CREATE INDEX progress_awaiting_verification_idx
  ON app.progress_entries (org_id, project_id, reported_at)
  WHERE verification_status = 'reported';
CREATE INDEX progress_reporter_idx
  ON app.progress_entries (org_id, reported_by, executed_on DESC);
CREATE INDEX progress_report_idx
  ON app.progress_entries (org_id, daily_report_id) WHERE daily_report_id IS NOT NULL;
CREATE UNIQUE INDEX progress_client_uuid_key
  ON app.progress_entries (org_id, client_uuid) WHERE client_uuid IS NOT NULL;

-- ── Quantity ledger: ONE truth for executed quantity ───────────────
-- FR-155/156. The reference FRD had progress entries and contractor
-- measurements as two independent mechanisms producing two quantities against
-- the same BOQ line, with no stated relationship. On a real site that produces
-- the argument where physical progress says 412 sqm, the measurement sheet
-- says 380, and nobody knows which feeds the dashboard.
--
-- One ledger with typed sources ends that argument. Phase 3 measurements post
-- here too, with source_type='measurement'.
CREATE TABLE app.quantity_ledger (
  id            UUID NOT NULL DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  work_item_id  UUID NOT NULL,
  location_id   UUID NOT NULL,

  source_type   app.quantity_source NOT NULL,
  source_id     UUID NOT NULL,

  qty           NUMERIC(18,4) NOT NULL,
  unit_id       UUID NOT NULL,
  executed_on   DATE NOT NULL,
  contractor_label TEXT,

  verification_status app.verification_status NOT NULL,
  -- Only measurement-sourced VERIFIED quantities are billable (FR-156). The
  -- column is generated so it can never drift from the two fields it derives
  -- from — and Phase 3 billing reads it rather than re-deriving the rule.
  is_billable   BOOLEAN GENERATED ALWAYS AS
                  (source_type = 'measurement' AND verification_status = 'verified') STORED,

  posted_by     UUID NOT NULL,
  posted_by_grant_id UUID,
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id, posted_at)
) PARTITION BY RANGE (posted_at);

COMMENT ON TABLE app.quantity_ledger IS
  'Append-only. One row per posting, keyed on work item x location, with the '
  'SOURCE typed. Dashboard progress uses all verified quantities; billing uses '
  'only measurement-sourced verified ones (FR-156).';

CREATE INDEX quantity_ledger_work_location_idx
  ON app.quantity_ledger (org_id, project_id, work_item_id, location_id, posted_at DESC);
CREATE INDEX quantity_ledger_source_idx
  ON app.quantity_ledger (org_id, source_type, source_id);
CREATE INDEX quantity_ledger_verified_idx
  ON app.quantity_ledger (org_id, project_id, work_item_id)
  WHERE verification_status = 'verified';

CREATE TRIGGER daily_reports_touch BEFORE UPDATE ON app.daily_reports
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER progress_entries_touch BEFORE UPDATE ON app.progress_entries
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['daily_reports','progress_entries','quantity_ledger'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

DO $$
DECLARE m DATE;
BEGIN
  FOR m IN SELECT generate_series(
      date_trunc('month', now())::date - INTERVAL '1 month',
      date_trunc('month', now())::date + INTERVAL '3 months',
      INTERVAL '1 month')::date
  LOOP
    PERFORM app.ensure_month_partition('app.quantity_ledger'::regclass, m);
  END LOOP;
END $$;

-- ── A submitted report LOCKS its entries (FR-144) ──────────────────
-- In the service layer this would be a rule someone can forget. Here it is a
-- fact: once the day is submitted, its entries cannot be edited, only verified.
CREATE OR REPLACE FUNCTION app.progress_entry_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE locked TIMESTAMPTZ;
BEGIN
  IF OLD.daily_report_id IS NULL THEN RETURN NEW; END IF;
  SELECT locked_at INTO locked FROM app.daily_reports WHERE id = OLD.daily_report_id;
  IF locked IS NULL THEN RETURN NEW; END IF;

  -- Verification is still permitted on a locked report: locking stops the
  -- CLAIM changing, not the engineer doing their job.
  IF NEW.reported_qty  IS DISTINCT FROM OLD.reported_qty
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.location_id  IS DISTINCT FROM OLD.location_id
     OR NEW.executed_on  IS DISTINCT FROM OLD.executed_on THEN
    RAISE EXCEPTION
      'Daily report of % is submitted and locked. Raise an amendment instead of '
      'editing the claim.', OLD.executed_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER progress_entries_lock_guard
  BEFORE UPDATE ON app.progress_entries
  FOR EACH ROW EXECUTE FUNCTION app.progress_entry_lock_guard();
