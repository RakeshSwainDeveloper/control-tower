-- ═══════════════════════════════════════════════════════════════════
-- 0002_audit
-- Append-only audit trail, partitioned monthly, with UPDATE and DELETE
-- revoked at the database level.
--
-- Built BEFORE the modules that write, because retrofitting audit into
-- 30 endpoints costs more than building all 30. (MVP_MODULE_MAP.md §3)
--
-- Spec: FR-500..FR-508, FR-514 · MVP_DATABASE_SCOPE.md §§3.6, 8
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.audit_action AS ENUM (
  'create','update','transition','approve','reject','verify',
  'delete','archive','export','login','config_change','impersonation'
);

CREATE TYPE app.audit_source AS ENUM (
  'web','mobile','api','sync','job','impersonation','system'
);

CREATE TABLE app.audit_log (
  id                  UUID        NOT NULL DEFAULT app.uuid_v7(),
  org_id              UUID        NOT NULL,
  project_id          UUID,
  entity_type         TEXT        NOT NULL,
  entity_id           UUID        NOT NULL,
  action              app.audit_action NOT NULL,

  -- WHO, and — critically — AS WHAT. FR-030: "Ramesh approved this as
  -- Project Manager" is unambiguous; "Ramesh approved this" is not.
  -- This cannot be backfilled, which is why it exists from migration one.
  actor_user_id       UUID,
  actor_grant_id      UUID,
  responsibility_label TEXT,

  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source              app.audit_source NOT NULL DEFAULT 'api',
  device_id           TEXT,
  app_version         TEXT,
  ip                  INET,
  correlation_id      TEXT,

  changes             JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{field,old,new}]
  context             JSONB       NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE app.audit_log IS
  'APPEND ONLY. No UPDATE, no DELETE, for any role including platform staff '
  '(FR-502). Written in the SAME TRANSACTION as the change it describes '
  '(FR-508). Partitioned monthly: 300k-800k rows/year at one project.';

CREATE INDEX audit_log_entity_idx
  ON app.audit_log (org_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx
  ON app.audit_log (org_id, actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_project_idx
  ON app.audit_log (org_id, project_id, occurred_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX audit_log_correlation_idx
  ON app.audit_log (correlation_id) WHERE correlation_id IS NOT NULL;

ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.audit_log
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- Partition maintenance. A missing future partition is a classic 2am
-- outage, so the worker calls this ahead of time and monitoring alerts on it.
CREATE OR REPLACE FUNCTION app.ensure_month_partition(
  parent regclass, month_start date
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  parent_name TEXT;
  part_name   TEXT;
  next_month  DATE := (date_trunc('month', month_start) + INTERVAL '1 month')::date;
  from_bound  DATE := date_trunc('month', month_start)::date;
BEGIN
  -- Take the bare relation name from the catalogue, NOT from parent::text.
  -- regclass::text omits the schema whenever that schema is on search_path,
  -- so string-splitting it yields '' and every partition ends up named
  -- '_YYYYMM'. The bounds still work, which is exactly why this survives
  -- casual testing and then breaks archival tooling months later.
  SELECT c.relname INTO parent_name FROM pg_class c WHERE c.oid = parent;
  IF parent_name IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: unknown relation %', parent;
  END IF;

  part_name := format('%s_%s', parent_name, to_char(from_bound, 'YYYYMM'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = part_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
      part_name, parent_name, from_bound, next_month);
  END IF;
  RETURN part_name;
END $$;

COMMENT ON FUNCTION app.ensure_month_partition(regclass, date) IS
  'Idempotently creates the monthly partition covering month_start. Called '
  'hourly by the worker three months ahead: a missing future partition is a '
  'classic 2am outage.';

-- Seed: previous, current and next three months.
DO $$
DECLARE m DATE;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', now())::date - INTERVAL '1 month',
      date_trunc('month', now())::date + INTERVAL '3 months',
      INTERVAL '1 month')::date
  LOOP
    PERFORM app.ensure_month_partition('app.audit_log'::regclass, m);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- THE LOCKDOWN.
-- The application role may INSERT and SELECT. Nothing else. Ever.
-- Asserted by a test (STACK_AND_DOCKER_PLAN.md §7 rule 6) so that no
-- future migration can quietly widen it.
-- ═══════════════════════════════════════════════════════════════════
REVOKE ALL ON app.audit_log FROM PUBLIC;

DO $$
DECLARE app_role TEXT := current_setting('ct.app_role', true);
BEGIN
  IF app_role IS NULL OR app_role = '' THEN app_role := 'ct_app'; END IF;
  EXECUTE format('REVOKE ALL ON app.audit_log FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON app.audit_log TO %I', app_role);
  -- Belt and braces: exclude audit_log from the schema-wide default grants.
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_log FROM %I', app_role);
END $$;

-- ── Platform audit (no org_id, separate stream) ────────────────────
-- Every platform action that touches tenant data ALSO writes a visible
-- entry into that tenant's own audit_log. FR-510: a customer must be able
-- to see what we did inside their account without asking us.
CREATE TABLE app.platform_audit_log (
  id                UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  platform_user_id  UUID REFERENCES app.platform_users(id),
  platform_role     TEXT,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         UUID,
  target_org_id     UUID,
  reason            TEXT,
  changes           JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip                INET,
  correlation_id    TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_occurred_idx ON app.platform_audit_log (occurred_at DESC);
CREATE INDEX platform_audit_org_idx      ON app.platform_audit_log (target_org_id, occurred_at DESC);

REVOKE ALL ON app.platform_audit_log FROM PUBLIC;
DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON app.platform_audit_log TO %I', app_role);
END $$;
