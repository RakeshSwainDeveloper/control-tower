-- 0027: approval_versions was missing its org_id-leading index.
--
-- Every table under FORCE ROW LEVEL SECURITY is read through a policy that
-- filters org_id, so org_id is the leading predicate on literally every query
-- against the table — including the ones the planner sees, not just the ones
-- we write. Without a leading org_id index the policy degrades to a scan of
-- every tenant's rows, discarding all but one tenant's.
--
-- 0024 gave the other five approval tables this index and missed this one.
-- The schema-conventions test caught it, which is why that test asserts the
-- rule across the whole catalogue rather than per table.
--
-- The unique (definition_id, version_no) constraint stays: it is what makes a
-- published version number mean something. This index serves the lookups that
-- go the other way — "every version this tenant has published".

CREATE INDEX IF NOT EXISTS approval_versions_org_definition_idx
  ON app.approval_versions (org_id, definition_id, version_no DESC);
