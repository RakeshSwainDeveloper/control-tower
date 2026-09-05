-- ═══════════════════════════════════════════════════════════════════
-- 0003_partition_rls
--
-- SECURITY FIX. A partition does NOT inherit its parent's row-level
-- security policy. Reading `app.audit_log` with a foreign tenant context
-- correctly returned 0 rows, but reading `app.audit_log_202609` directly
-- returned the row — a cross-tenant read of the audit trail.
--
-- Postgres applies the parent's policies only when the table is accessed
-- through the parent. Direct partition access applies the partition's own
-- policies, and a freshly created partition has none.
--
-- Every partition therefore gets its own ENABLE + FORCE + policy, and the
-- creation function does this atomically so a partition can never exist in
-- an unprotected state. Caught by test/isolation.test.ts.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app.secure_partition(part_name text)
RETURNS void
LANGUAGE plpgsql AS $$
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

COMMENT ON FUNCTION app.secure_partition(text) IS
  'Applies tenant RLS to a single partition. Partitions do NOT inherit the '
  'parent policy on direct access, so this is mandatory, not defensive.';

-- Recreate the partition factory so protection is applied at creation time.
CREATE OR REPLACE FUNCTION app.ensure_month_partition(
  parent regclass, month_start date
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  parent_name TEXT;
  part_name   TEXT;
  from_bound  DATE := date_trunc('month', month_start)::date;
  next_month  DATE := (date_trunc('month', month_start) + INTERVAL '1 month')::date;
  has_org_id  BOOLEAN;
BEGIN
  -- Bare relation name from the catalogue, never from parent::text:
  -- regclass::text omits the schema when it is on search_path, so
  -- string-splitting it yields '' and partitions end up named '_YYYYMM'.
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

  -- Secure it if, and only if, it is tenant-scoped.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = part_name AND column_name = 'org_id'
  ) INTO has_org_id;

  IF has_org_id THEN
    PERFORM app.secure_partition(part_name);
  END IF;

  RETURN part_name;
END $$;

-- Backfill every partition that already exists.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = 'app' AND col.table_name = c.relname
     AND col.column_name = 'org_id'
    WHERE n.nspname = 'app' AND c.relispartition AND c.relkind = 'r'
  LOOP
    PERFORM app.secure_partition(r.relname);
    RAISE NOTICE 'secured partition app.%', r.relname;
  END LOOP;
END $$;

-- Partitions inherit grants from the parent, so the audit_log lockdown
-- (INSERT + SELECT only) already covers them. Re-assert it explicitly so a
-- future partition can never be created with wider privileges.
DO $$
DECLARE
  app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relispartition
      AND c.relkind = 'r'            -- 'r' only: partitioned INDEXES are also
      AND c.relname LIKE 'audit_log_%'  -- relispartition, and REVOKE on an
  LOOP                                  -- index is an error.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON app.%I FROM %I', r.relname, app_role);
  END LOOP;
END $$;
