-- ═══════════════════════════════════════════════════════════════════
-- 0016_work_items   ·   PHASE 3 · M5
--
-- The MVP's simplification of the three-way WBS / BOQ item / cost head split
-- (PRODUCT_REVIEW.md §4.1). That split is right for the full product and wrong
-- for a release with no money in it: three tables, a many-to-many mapping and
-- an import pipeline to answer one question — how much of what was planned is
-- done.
--
-- One table. The Phase 2/3 hooks are nullable columns, so the split is an
-- ADDITION later, never a migration of existing rows.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE app.work_items (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,

  -- One optional level of grouping. Deeper hierarchy is what WBS is for, and
  -- WBS is Phase 3.
  parent_id   UUID REFERENCES app.work_items(id) ON DELETE RESTRICT,

  code        TEXT NOT NULL,
  description TEXT NOT NULL,
  unit_id     UUID NOT NULL REFERENCES app.units(id) ON DELETE RESTRICT,

  planned_qty NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (planned_qty >= 0),

  work_category_id UUID REFERENCES app.master_data(id) ON DELETE SET NULL,
  spec_reference   TEXT,

  -- ── Phase 2/3 attachment points. Nullable, unpopulated, indexed nowhere. ──
  wbs_node_id  UUID,
  cost_head_id UUID,
  planned_rate BIGINT,

  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  created_by_grant_id UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  version     INTEGER NOT NULL DEFAULT 1,

  UNIQUE (org_id, project_id, code),
  CONSTRAINT work_items_no_money_in_mvp CHECK (planned_rate IS NULL)
);
CREATE INDEX work_items_project_idx ON app.work_items (org_id, project_id, sort_order)
  WHERE is_active;
CREATE INDEX work_items_parent_idx  ON app.work_items (org_id, parent_id)
  WHERE parent_id IS NOT NULL;

COMMENT ON TABLE app.work_items IS
  'The MVP stand-in for WBS + BOQ item + cost head. wbs_node_id, cost_head_id '
  'and planned_rate exist as nullable columns so Phase 3 attaches by addition.';

-- ── Planned quantity per location (FR-124) ─────────────────────────
-- Progress is tracked per unit, not just per line, so "Flat 502 is 87% plastered"
-- is answerable. Without this the only answerable question is about the whole
-- project, which is not a question anyone on site asks.
CREATE TABLE app.work_item_locations (
  id           UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id       UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL REFERENCES app.work_items(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES app.locations(id) ON DELETE CASCADE,
  planned_qty  NUMERIC(18,4) NOT NULL CHECK (planned_qty >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (work_item_id, location_id)
);
CREATE INDEX wil_location_idx  ON app.work_item_locations (org_id, project_id, location_id);
CREATE INDEX wil_work_item_idx ON app.work_item_locations (org_id, work_item_id);

-- ── Import staging (FR-122) ────────────────────────────────────────
-- Three steps, always: upload → preview → confirm. NOTHING is written to
-- work_items before confirmation. An import that half-succeeds leaves a project
-- in a state nobody can reason about, and "delete the rows I just made" is not
-- a recovery procedure anyone should need.
CREATE TABLE app.import_jobs (
  id           UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id       UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  filename     TEXT,
  status       TEXT NOT NULL DEFAULT 'previewing'
               CHECK (status IN ('previewing','confirmed','cancelled','failed')),
  column_map   JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_rows   INTEGER NOT NULL DEFAULT 0,
  valid_rows   INTEGER NOT NULL DEFAULT 0,
  error_rows   INTEGER NOT NULL DEFAULT 0,
  rows         JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX import_jobs_project_idx ON app.import_jobs (org_id, project_id, created_at DESC);

CREATE TRIGGER work_items_touch  BEFORE UPDATE ON app.work_items  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER wil_touch         BEFORE UPDATE ON app.work_item_locations FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER import_jobs_touch BEFORE UPDATE ON app.import_jobs FOR EACH ROW EXECUTE FUNCTION app.touch_row();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_items','work_item_locations','import_jobs'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- Allocated quantity must never exceed the line's planned quantity: allocating
-- 60 sqm of a 48 sqm line means one of the two numbers is wrong, and finding
-- out at billing time is too late.
CREATE OR REPLACE FUNCTION app.assert_allocation_within_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_planned   NUMERIC(18,4);
  v_allocated NUMERIC(18,4);
  v_code      TEXT;
BEGIN
  SELECT planned_qty, code INTO v_planned, v_code
  FROM app.work_items WHERE id = NEW.work_item_id;

  SELECT COALESCE(sum(planned_qty), 0) INTO v_allocated
  FROM app.work_item_locations
  WHERE work_item_id = NEW.work_item_id AND id <> COALESCE(NEW.id, gen_random_uuid());

  IF v_allocated + NEW.planned_qty > v_planned + 0.0001 THEN
    RAISE EXCEPTION
      'Allocating % to work item % would total %, over its planned quantity of %',
      NEW.planned_qty, v_code, v_allocated + NEW.planned_qty, v_planned
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wil_within_plan
  BEFORE INSERT OR UPDATE OF planned_qty ON app.work_item_locations
  FOR EACH ROW EXECUTE FUNCTION app.assert_allocation_within_plan();
