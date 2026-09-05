-- ═══════════════════════════════════════════════════════════════════
-- 0017_import_jobs_updated_at
--
-- app.import_jobs carried a touch_row trigger but no updated_at column, so any
-- UPDATE failed with 'record "new" has no field "updated_at"'. It only surfaced
-- on import confirmation — the one UPDATE that table ever receives.
--
-- The class of bug is a trigger and a table disagreeing about columns, which no
-- amount of care prevents. test/schema-conventions.test.ts now asserts the
-- agreement for every table.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE app.import_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
