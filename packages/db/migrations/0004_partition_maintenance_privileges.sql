-- ═══════════════════════════════════════════════════════════════════
-- 0004_partition_maintenance_privileges
--
-- DEFECT: the worker runs as ct_app and cannot execute
-- app.ensure_month_partition(). It fails twice over:
--   · CREATE TABLE ... PARTITION OF  -> needs CREATE on schema app
--   · ALTER TABLE ... ENABLE RLS     -> needs table OWNERSHIP
--
-- Consequence had this shipped: partition maintenance never runs. The
-- partitions that exist today were created by migrations running as
-- ct_migrator, and they stop at 2027-01. The first INSERT after that date
-- fails with "no partition of relation audit_log found", and because every
-- audited write carries an audit row IN THE SAME TRANSACTION (FR-508),
-- *every write in the product* starts failing at midnight. This is exactly
-- the 2am outage the function's own comment warned about.
--
-- FIX: SECURITY DEFINER, so the function executes with the owner's rights,
-- with a pinned search_path and an explicit guard on what it may touch.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app.secure_partition(part_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog     -- pinned: a SECURITY DEFINER function
AS $$                                 -- with a mutable search_path is hijackable
BEGIN
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', part_name);
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'app' AND tablename = part_name AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', part_name);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.ensure_month_partition(
  parent regclass, month_start date
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  parent_name TEXT;
  parent_ns   TEXT;
  parent_kind "char";
  part_name   TEXT;
  from_bound  DATE := date_trunc('month', month_start)::date;
  next_month  DATE := (date_trunc('month', month_start) + INTERVAL '1 month')::date;
  has_org_id  BOOLEAN;
BEGIN
  -- Bare relation name from the catalogue, never from parent::text:
  -- regclass::text omits the schema when it is on search_path, so
  -- string-splitting it yields '' and partitions end up named '_YYYYMM'.
  SELECT c.relname, n.nspname, c.relkind
    INTO parent_name, parent_ns, parent_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = parent;

  IF parent_name IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: unknown relation %', parent;
  END IF;

  -- SECURITY DEFINER means this runs with the owner's rights, so it must not
  -- be usable as a general "create me a table anywhere" primitive. Constrain
  -- it to partitioned tables in the app schema.
  IF parent_ns <> 'app' OR parent_kind <> 'p' THEN
    RAISE EXCEPTION
      'ensure_month_partition: % is not a partitioned table in schema app', parent;
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

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = part_name AND column_name = 'org_id'
  ) INTO has_org_id;

  IF has_org_id THEN
    PERFORM app.secure_partition(part_name);
  END IF;

  RETURN part_name;
END $$;

COMMENT ON FUNCTION app.ensure_month_partition(regclass, date) IS
  'SECURITY DEFINER: executed by the application role but with the owner''s '
  'rights, because creating a partition and enabling RLS on it both require '
  'ownership. Constrained to partitioned tables in schema app.';

-- Only the application role needs to call these. Revoke the implicit PUBLIC
-- EXECUTE that every new function receives.
REVOKE ALL ON FUNCTION app.secure_partition(text)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ensure_month_partition(regclass, date) FROM PUBLIC;

DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.secure_partition(text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.ensure_month_partition(regclass, date) TO %I', app_role);
END $$;

-- The 2027-03 partition created during verification is legitimate; leave it.
-- Re-secure everything, in case any partition was created before this fix.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = 'app' AND col.table_name = c.relname AND col.column_name = 'org_id'
    WHERE n.nspname = 'app' AND c.relispartition AND c.relkind = 'r'
  LOOP
    PERFORM app.secure_partition(r.relname);
  END LOOP;
END $$;
