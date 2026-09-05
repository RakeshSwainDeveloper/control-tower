-- ═══════════════════════════════════════════════════════════════════
-- 0018_audit_action_import
--
-- A bulk import is not the same event as a hand-created row. "Who added these
-- 400 work items, from which file, and how many did the preview reject" is a
-- real audit question, and answering it with 400 identical 'create' rows and a
-- context blob loses the shape of what happened.
-- ═══════════════════════════════════════════════════════════════════

ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'import';
