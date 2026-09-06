-- 0029: indexes for the keyset pagination the list endpoints actually use.
--
-- Phase 1 chose keyset pagination over OFFSET so a page could not drift while
-- somebody was reading it. The indexes were then all built on dates, so the
-- planner could not use any of them for `WHERE project_id = ? ORDER BY id DESC`
-- and fell back to reading every row for the project and top-N sorting it.
--
-- Measured on 7,500 progress entries (12 months, one project): 48 ms, with
-- "Rows Removed by Join Filter: 7500" to return 51 rows. Linear in everything
-- the site has ever recorded.
--
-- (org_id, project_id, id DESC) matches the query exactly: RLS supplies
-- org_id, the endpoint supplies project_id, and the cursor walks id.

CREATE INDEX IF NOT EXISTS progress_entries_keyset_idx
  ON app.progress_entries (org_id, project_id, id DESC);

CREATE INDEX IF NOT EXISTS issues_keyset_idx
  ON app.issues (org_id, project_id, id DESC);

-- The audit log paginates the same way, on (occurred_at DESC, id DESC) so the
-- order stays stable when two rows share a millisecond. It is partitioned, so
-- this creates the index on every partition and on every future one.
CREATE INDEX IF NOT EXISTS audit_log_keyset_idx
  ON app.audit_log (org_id, occurred_at DESC, id DESC);

-- Filtering the audit by record is how the per-record timeline is built, and
-- it had no index at all.
CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON app.audit_log (org_id, entity_type, entity_id, occurred_at);
