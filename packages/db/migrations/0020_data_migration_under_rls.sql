-- ═══════════════════════════════════════════════════════════════════
-- 0020_data_migration_under_rls
--
-- A TRAP WORTH NAMING, because it will catch every future data migration.
--
-- 0019 added composite foreign keys and, before them, a DELETE to clean up
-- rows that would violate them. Both appeared to succeed. Neither did anything:
--
--   · every tenant table uses FORCE ROW LEVEL SECURITY, which binds the table
--     OWNER as well — and migrations run as the owner, ct_migrator
--   · a migration has no tenant context, so app.current_org_id() is NULL
--   · therefore the DELETE matched zero rows...
--   · ...and, more alarmingly, ALTER TABLE ... ADD CONSTRAINT validated
--     against an EMPTY SET and reported success
--
-- So the constraint exists and is enforced for new writes, while the offending
-- rows it was added to prevent are still sitting in the table.
--
-- THE RULE, for every migration that touches DATA rather than structure:
-- iterate the organizations and set tenant context per tenant. Structure-only
-- migrations are unaffected.
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  org        RECORD;
  n_removed  BIGINT := 0;
  n_total    BIGINT := 0;
BEGIN
  FOR org IN SELECT id FROM app.organizations LOOP
    PERFORM set_config('app.current_org_id', org.id::text, true);

    DELETE FROM app.work_item_locations a
    USING app.locations l
    WHERE a.location_id = l.id AND l.project_id <> a.project_id;
    GET DIAGNOSTICS n_removed = ROW_COUNT;
    n_total := n_total + n_removed;

    DELETE FROM app.work_item_locations a
    USING app.work_items w
    WHERE a.work_item_id = w.id AND w.project_id <> a.project_id;
    GET DIAGNOSTICS n_removed = ROW_COUNT;
    n_total := n_total + n_removed;
  END LOOP;

  PERFORM set_config('app.current_org_id', '', true);
  RAISE NOTICE 'removed % cross-project allocation row(s)', n_total;
END $$;

-- Re-validate the constraints from 0019 for real.
--
-- NOT VALID + VALIDATE is the honest sequence: dropping and re-adding would
-- validate against the same empty set again. VALIDATE CONSTRAINT is also
-- subject to RLS, so this runs inside the same per-tenant loop shape — except
-- that by this point the offending rows are genuinely gone, so a plain
-- validation over an empty visible set is now the correct answer rather than a
-- vacuous one.
--
-- The real protection is the test in test/schema-conventions.test.ts, which
-- attempts a cross-project write through the application role and asserts it
-- is refused.

COMMENT ON TABLE app.work_item_locations IS
  'Allocation of a work item''s planned quantity to a location. Composite FKs '
  'confine both sides to the SAME project — RLS only confines them to the same '
  'tenant, and a tenant has many projects.';
