-- 0026: audit_action gains 'comment'.
--
-- Phase 6 introduces comments and queries. A query raised against a record is
-- a real event in that record's history — it is what blocks the record from
-- closing — so it belongs in the audit trail under its own name rather than
-- folded into 'update'.
--
-- This is the second time a phase has shipped a new action without its enum
-- label (0018 added 'import'). The typecheck gate caught it before the code
-- ran, which is the whole reason that gate exists.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'comment';
