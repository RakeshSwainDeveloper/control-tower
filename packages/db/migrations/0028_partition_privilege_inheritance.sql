-- 0028: partitions do not inherit their parent's PRIVILEGES either.
--
-- Phase 1 found that a partition does not inherit its parent's RLS policy, and
-- 0003 fixed that. This is the same lesson a second time, on the other half of
-- the access control system.
--
-- What was actually true before this migration:
--
--     UPDATE app.approval_decisions            → permission denied   ✓
--     UPDATE app.approval_decisions_202609     → UPDATE 0            ✗
--
-- The append-only guarantee held only for callers who happened to name the
-- parent. Naming the partition directly went straight through.
--
-- 0003's own comment claimed "partitions inherit grants from the parent" and
-- then re-asserted the revoke "so a future partition can never be created with
-- wider privileges". Both halves were wrong. A new partition is a NEW TABLE: it
-- takes its ACL from ALTER DEFAULT PRIVILEGES (which grants the app role full
-- DML), not from its parent. And a one-shot DO loop over the partitions that
-- existed in 2026-09 cannot constrain a partition created in 2027-01.
--
-- The blast radius is wider than the Phase 6 table that exposed it. Every
-- monthly partition the worker creates from now on — audit_log included — was
-- going to arrive writable. The audit trail would have quietly stopped being
-- append-only at the first month roll, which is exactly the kind of guarantee
-- that is never re-tested because it was verified once, at the start.
--
-- The fix belongs in app.secure_partition, not in a list of table names: it is
-- called for every partition with an org_id, so mirroring the parent's grants
-- there fixes every append-only partitioned table that exists now and every one
-- added later, without anybody having to remember.

CREATE OR REPLACE FUNCTION app.secure_partition(part_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog   -- SECURITY DEFINER with a mutable
AS $$                               -- search_path is hijackable
DECLARE
  app_role    TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
  parent_name TEXT;
  priv        TEXT;
  granted     TEXT[] := '{}';
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

  -- Mirror the PARENT's privileges for the application role.
  --
  -- Read from the parent rather than from a hardcoded list, so an append-only
  -- parent produces an append-only partition and an ordinary parent produces an
  -- ordinary one. No table needs to be named here.
  SELECT p.relname INTO parent_name
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = part_name;

  IF parent_name IS NULL THEN
    RETURN;   -- not a partition; nothing to mirror
  END IF;

  FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF has_table_privilege(app_role, format('app.%I', parent_name)::regclass, priv) THEN
      granted := granted || priv;
    END IF;
  END LOOP;

  EXECUTE format('REVOKE ALL ON app.%I FROM %I', part_name, app_role);
  IF array_length(granted, 1) > 0 THEN
    EXECUTE format('GRANT %s ON app.%I TO %I',
                   array_to_string(granted, ', '), part_name, app_role);
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.secure_partition(text) FROM PUBLIC;
DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.secure_partition(text) TO %I', app_role);
END $$;

-- Repair every partition that already exists — all of them, not one prefix.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relispartition
      AND c.relkind = 'r'          -- 'r' only: partitioned INDEXES are also
  LOOP                             -- relispartition, and REVOKE on one errors
    PERFORM app.secure_partition(r.relname);
  END LOOP;
END $$;
