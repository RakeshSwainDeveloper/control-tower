-- ═══════════════════════════════════════════════════════════════════
-- 0015_projects_locations   ·   PHASE 3 · M4
--
-- Spec: MVP_SCOPE.md §4 (M4) · FR-100..FR-108, FR-111
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE app.projects (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  company_id  UUID NOT NULL REFERENCES app.companies(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  -- Free text in the MVP: the client is not a login until Phase 2 adds
  -- external users, and modelling a party we cannot yet authenticate would be
  -- a table nobody writes to.
  client_name TEXT,

  planned_start  DATE,
  planned_finish DATE,
  actual_start   DATE,
  actual_finish  DATE,

  status_id   UUID REFERENCES app.statuses(id),
  state_class app.state_class NOT NULL DEFAULT 'draft',

  -- FR-103: never empty. Every project has someone accountable for delivery
  -- and someone accountable commercially, even when they are the same person
  -- on a small job. A project with an empty owner is how work becomes nobody's.
  accountable_manager_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  commercial_owner_user_id    UUID NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,

  -- Declared, never populated in the MVP. The no-money boundary is enforced by
  -- a test, not by absence: see the migration-lint test.
  contract_value BIGINT,
  currency       CHAR(3),

  location_label_scheme TEXT[] NOT NULL
    DEFAULT ARRAY['Block','Floor','Unit','Room']::text[],
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  geo_lat     NUMERIC(9,6),
  geo_lng     NUMERIC(9,6),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  created_by_grant_id UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  version     INTEGER NOT NULL DEFAULT 1,

  UNIQUE (org_id, code),
  CONSTRAINT projects_planned_dates CHECK (
    planned_finish IS NULL OR planned_start IS NULL OR planned_finish >= planned_start),
  CONSTRAINT projects_actual_dates CHECK (
    actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start),
  -- No money in the MVP (PRODUCT_REVIEW.md §14). The columns exist so Phase 3
  -- is additive; this constraint makes "declared but unused" enforceable
  -- rather than aspirational.
  CONSTRAINT projects_no_money_in_mvp CHECK (contract_value IS NULL AND currency IS NULL)
);
CREATE INDEX projects_org_state_idx ON app.projects (org_id, state_class);
CREATE INDEX projects_manager_idx   ON app.projects (org_id, accountable_manager_user_id);

COMMENT ON CONSTRAINT projects_no_money_in_mvp ON app.projects IS
  'Dropped in Phase 3 when the commercial chain arrives. Until then it turns '
  'the no-money scope boundary into something the database enforces.';

-- ── Locations: a tree of arbitrary depth ───────────────────────────
CREATE TABLE app.locations (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  parent_id   UUID REFERENCES app.locations(id) ON DELETE RESTRICT,

  level_index SMALLINT NOT NULL DEFAULT 0,
  level_name  TEXT,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,

  -- Materialised path. A subtree rollup is `path <@ :ancestor`, which a GIST
  -- index answers directly — no recursive CTE on the hot path of every
  -- location-filtered list.
  path        LTREE NOT NULL,

  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','in_progress','complete','handed_over')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  created_by_grant_id UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  version     INTEGER NOT NULL DEFAULT 1,

  UNIQUE (org_id, project_id, path)
);
CREATE INDEX locations_path_gist   ON app.locations USING GIST (path);
CREATE INDEX locations_project_idx ON app.locations (org_id, project_id, parent_id);
CREATE INDEX locations_active_idx  ON app.locations (org_id, project_id, level_index)
  WHERE is_active;

COMMENT ON COLUMN app.locations.path IS
  'Materialised ltree path. Subtree rollup is path <@ ancestor, answered by the '
  'GIST index — the alternative is a recursive CTE on every location filter.';

-- Displayable path, built once per row rather than joined up the tree on read.
CREATE TABLE app.location_paths (
  location_id UUID PRIMARY KEY REFERENCES app.locations(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL,
  project_id  UUID NOT NULL,
  display_path TEXT NOT NULL,   -- 'Tower A › Floor 5 › Flat 502 › Bathroom'
  depth       SMALLINT NOT NULL
);
CREATE INDEX location_paths_project_idx ON app.location_paths (org_id, project_id);

CREATE TRIGGER projects_touch  BEFORE UPDATE ON app.projects  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER locations_touch BEFORE UPDATE ON app.locations FOR EACH ROW EXECUTE FUNCTION app.touch_row();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','locations','location_paths'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- ── Path maintenance ───────────────────────────────────────────────
-- Kept in a trigger rather than the service layer: a location inserted by a
-- migration, a seed or a future import must get a correct path too, and
-- "remember to call buildPath()" is not a guarantee.
CREATE OR REPLACE FUNCTION app.locations_maintain_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_path  LTREE;
  parent_disp  TEXT;
  parent_depth SMALLINT;
  label        TEXT;
BEGIN
  -- ltree labels accept only [A-Za-z0-9_], so the code is sanitised for the
  -- path while `code` and `name` keep whatever the user typed.
  label := regexp_replace(NEW.code, '[^A-Za-z0-9_]', '_', 'g');
  IF label = '' THEN label := 'n' || replace(NEW.id::text, '-', ''); END IF;

  IF NEW.parent_id IS NULL THEN
    NEW.path := label::ltree;
    NEW.level_index := 0;
  ELSE
    SELECT l.path, lp.display_path, lp.depth
      INTO parent_path, parent_disp, parent_depth
    FROM app.locations l
    LEFT JOIN app.location_paths lp ON lp.location_id = l.id
    WHERE l.id = NEW.parent_id;

    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'Parent location % not found in this project', NEW.parent_id;
    END IF;
    NEW.path := parent_path || label::ltree;
    NEW.level_index := nlevel(NEW.path)::smallint - 1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.locations_sync_display_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_disp TEXT;
BEGIN
  IF NEW.parent_id IS NULL THEN
    parent_disp := NULL;
  ELSE
    SELECT display_path INTO parent_disp FROM app.location_paths WHERE location_id = NEW.parent_id;
  END IF;

  INSERT INTO app.location_paths (location_id, org_id, project_id, display_path, depth)
  VALUES (
    NEW.id, NEW.org_id, NEW.project_id,
    CASE WHEN parent_disp IS NULL THEN NEW.name ELSE parent_disp || ' › ' || NEW.name END,
    nlevel(NEW.path)::smallint
  )
  ON CONFLICT (location_id) DO UPDATE
    SET display_path = EXCLUDED.display_path, depth = EXCLUDED.depth;

  -- A rename must reach the descendants too, or half the tree shows the old
  -- name and nobody can tell which half.
  IF TG_OP = 'UPDATE' AND (OLD.name IS DISTINCT FROM NEW.name) THEN
    UPDATE app.location_paths lp
    SET display_path = sub.rebuilt
    FROM (
      SELECT d.id,
             string_agg(a.name, ' › ' ORDER BY nlevel(a.path)) AS rebuilt
      FROM app.locations d
      JOIN app.locations a
        ON a.project_id = d.project_id AND d.path <@ a.path
      WHERE d.project_id = NEW.project_id AND d.path <@ NEW.path AND d.id <> NEW.id
      GROUP BY d.id
    ) sub
    WHERE lp.location_id = sub.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER locations_path_before
  BEFORE INSERT OR UPDATE OF parent_id, code ON app.locations
  FOR EACH ROW EXECUTE FUNCTION app.locations_maintain_path();

CREATE TRIGGER locations_path_after
  AFTER INSERT OR UPDATE OF parent_id, code, name ON app.locations
  FOR EACH ROW EXECUTE FUNCTION app.locations_sync_display_path();
