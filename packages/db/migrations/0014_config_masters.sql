-- ═══════════════════════════════════════════════════════════════════
-- 0014_config_masters   ·   PHASE 3
--
-- Statuses, units and generic master data.
--
-- Spec: MVP_SCOPE.md §6 (fixed statuses) · FR-541/542 · FR-083/085
-- ═══════════════════════════════════════════════════════════════════

-- ── Statuses: configurable LABEL over a fixed STATE CLASS ──────────
-- FR-541. The MVP ships label = state_class and no editor, but the table
-- exists now so Phase 2 turns the editor on with zero schema change. Business
-- rules, permissions, reports and indexes read state_class; only the UI reads
-- the label.
CREATE TABLE app.statuses (
  id           UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id       UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  code         TEXT NOT NULL,
  label        TEXT NOT NULL,
  state_class  app.state_class NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  colour       TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  is_terminal  BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, entity_type, code)
);
CREATE INDEX statuses_entity_idx ON app.statuses (org_id, entity_type, sort_order);
CREATE UNIQUE INDEX statuses_one_default_per_entity
  ON app.statuses (org_id, entity_type) WHERE is_default;

COMMENT ON COLUMN app.statuses.state_class IS
  'The semantic anchor. Code reasons about this; users see the label. Without '
  'it a rule like "not editable after approval" cannot be written, because code '
  'cannot know which of a tenant''s statuses means approved.';

-- ── Units of measure ───────────────────────────────────────────────
-- FR-085: a unit carries a DIMENSION, and arithmetic across dimensions is
-- blocked. Adding square metres to cubic metres is not a rounding error, it is
-- a category error, and it should be impossible rather than merely unlikely.
CREATE TYPE app.unit_dimension AS ENUM (
  'length', 'area', 'volume', 'mass', 'count', 'time'
);

CREATE TABLE app.units (
  id             UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id         UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  dimension      app.unit_dimension NOT NULL,
  -- Factor to the dimension's base unit (m, m2, m3, kg, each, hour).
  -- Conversion is only ever offered WITHIN a dimension.
  base_factor    NUMERIC(18,8) NOT NULL DEFAULT 1,
  decimal_places SMALLINT NOT NULL DEFAULT 2 CHECK (decimal_places BETWEEN 0 AND 4),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  version        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

-- ── Generic master data (categories, types, reasons) ───────────────
-- One table rather than a dozen near-identical ones. Everything here is a
-- short, tenant-editable list that a dropdown renders and a record references.
CREATE TABLE app.master_data (
  id          UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,       -- work_category | issue_category | issue_severity | …
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, kind, code)
);
CREATE INDEX master_data_kind_idx ON app.master_data (org_id, kind, sort_order)
  WHERE is_active;

-- ── Document numbering (FR-081/082, BR-19) ─────────────────────────
-- Numbers are allocated SERVER-SIDE at submission, never on the client.
-- Client-allocated numbers plus an offline queue equals duplicate PO numbers,
-- which has sunk more than one homegrown system.
CREATE TABLE app.numbering_series (
  id             UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id         UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,
  prefix         TEXT NOT NULL DEFAULT '',
  separator      TEXT NOT NULL DEFAULT '/',
  include_project_code BOOLEAN NOT NULL DEFAULT false,
  include_fy     BOOLEAN NOT NULL DEFAULT true,
  sequence_width SMALLINT NOT NULL DEFAULT 4 CHECK (sequence_width BETWEEN 3 AND 8),
  reset_policy   TEXT NOT NULL DEFAULT 'yearly'
                 CHECK (reset_policy IN ('never', 'yearly', 'per_project')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  version        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, entity_type)
);

-- The counter is separate from the format so that changing a prefix never
-- resets a sequence, and so allocation can lock one narrow row.
CREATE TABLE app.numbering_counters (
  org_id      UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  scope_key   TEXT NOT NULL,        -- '' | fiscal year | project id
  last_value  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, entity_type, scope_key)
);

CREATE TRIGGER statuses_touch         BEFORE UPDATE ON app.statuses         FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER units_touch            BEFORE UPDATE ON app.units            FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER master_data_touch      BEFORE UPDATE ON app.master_data      FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER numbering_series_touch BEFORE UPDATE ON app.numbering_series FOR EACH ROW EXECUTE FUNCTION app.touch_row();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'statuses','units','master_data','numbering_series','numbering_counters'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- ── Number allocation ──────────────────────────────────────────────
-- SECURITY INVOKER on purpose: it runs inside the caller's tenant context, so
-- RLS still applies and it cannot allocate a number for another tenant.
CREATE OR REPLACE FUNCTION app.next_document_number(
  p_entity_type text, p_project_code text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s          RECORD;
  v_org      uuid := app.current_org_id();
  v_scope    text := '';
  v_fy       text;
  v_next     bigint;
  v_parts    text[] := '{}';
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'next_document_number requires tenant context';
  END IF;

  SELECT * INTO s FROM app.numbering_series
  WHERE org_id = v_org AND entity_type = p_entity_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No numbering series configured for %', p_entity_type;
  END IF;

  -- Indian fiscal year: April to March.
  v_fy := CASE
    WHEN extract(month FROM now()) >= 4
      THEN to_char(now(), 'YYYY') || '-' || to_char(now() + interval '1 year', 'YY')
      ELSE to_char(now() - interval '1 year', 'YYYY') || '-' || to_char(now(), 'YY')
  END;

  v_scope := CASE s.reset_policy
    WHEN 'yearly'      THEN v_fy
    WHEN 'per_project' THEN COALESCE(p_project_code, '')
    ELSE ''
  END;

  -- One atomic upsert: concurrent submissions cannot collide on a number.
  INSERT INTO app.numbering_counters (org_id, entity_type, scope_key, last_value)
  VALUES (v_org, p_entity_type, v_scope, 1)
  ON CONFLICT (org_id, entity_type, scope_key)
  DO UPDATE SET last_value = app.numbering_counters.last_value + 1
  RETURNING last_value INTO v_next;

  IF s.prefix <> '' THEN v_parts := v_parts || s.prefix; END IF;
  IF s.include_project_code AND p_project_code IS NOT NULL THEN
    v_parts := v_parts || p_project_code;
  END IF;
  IF s.include_fy THEN v_parts := v_parts || v_fy; END IF;
  v_parts := v_parts || lpad(v_next::text, s.sequence_width, '0');

  RETURN array_to_string(v_parts, s.separator);
END $$;

COMMENT ON FUNCTION app.next_document_number(text, text) IS
  'Server-side number allocation (BR-19). SECURITY INVOKER so RLS still applies '
  'and a caller cannot allocate into another tenant''s series.';
