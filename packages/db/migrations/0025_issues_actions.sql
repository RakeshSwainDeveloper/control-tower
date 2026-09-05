-- ═══════════════════════════════════════════════════════════════════
-- 0025_issues_actions   ·   PHASE 6 · M10
--
-- ONE generic Action entity behind task, query and instruction, and an Issue
-- that carries quality AND safety through configurable categories
-- (PRODUCT_REVIEW.md §4.3).
--
-- The specialised NCR and incident lifecycles — containment, disposition, root
-- cause, statutory notification — are Phase 2. For an MVP, an issue with a
-- category and a severity carries a cracked tile and a missing harness
-- perfectly well: raise, assign, resolve with evidence, verify by someone else,
-- close. That removes two modules and a whole set of screens.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.issue_severity AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE app.action_subtype AS ENUM ('task', 'query', 'instruction', 'review');

CREATE TABLE app.issues (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES app.projects(id) ON DELETE CASCADE,
  issue_number  TEXT,

  category_id   UUID REFERENCES app.master_data(id) ON DELETE SET NULL,
  severity      app.issue_severity NOT NULL DEFAULT 'medium',
  title         TEXT NOT NULL,
  description   TEXT,

  location_id   UUID,
  work_item_id  UUID,
  contractor_label TEXT,

  assignee_user_id UUID REFERENCES app.users(id) ON DELETE SET NULL,
  due_date      DATE,

  status_id     UUID REFERENCES app.statuses(id),
  state_class   app.state_class NOT NULL DEFAULT 'draft',

  raised_by     UUID NOT NULL,
  raised_by_grant_id UUID,
  raised_responsibility TEXT,
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- SoD-03 needs to know who did the work, separately from who signs it off.
  resolved_by   UUID,
  resolved_by_grant_id UUID,
  resolved_responsibility TEXT,
  resolved_at   TIMESTAMPTZ,
  resolution_note TEXT,

  verified_by   UUID,
  verified_by_grant_id UUID,
  verified_responsibility TEXT,
  verified_at   TIMESTAMPTZ,

  closed_at     TIMESTAMPTZ,
  reopen_count  INTEGER NOT NULL DEFAULT 0,
  last_reopen_reason TEXT,

  -- Escalation is recorded so "nobody told me" is answerable.
  escalated_at  TIMESTAMPTZ,
  escalated_to_user_id UUID,

  client_uuid   UUID,
  is_offline_origin BOOLEAN NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT issues_resolution_needs_note CHECK (
    resolved_at IS NULL OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) >= 3)
  ),
  CONSTRAINT issues_location_same_project
    FOREIGN KEY (project_id, location_id) REFERENCES app.locations (project_id, id)
    ON DELETE SET NULL,
  CONSTRAINT issues_work_item_same_project
    FOREIGN KEY (project_id, work_item_id) REFERENCES app.work_items (project_id, id)
    ON DELETE SET NULL
);
CREATE INDEX issues_project_state_idx
  ON app.issues (org_id, project_id, state_class, due_date);
-- The open list, which is what every screen actually asks for. Partial, so it
-- stays small as closed issues accumulate behind it.
CREATE INDEX issues_open_idx
  ON app.issues (org_id, project_id, severity, due_date)
  WHERE state_class NOT IN ('closed', 'cancelled');
CREATE INDEX issues_assignee_idx
  ON app.issues (org_id, assignee_user_id, due_date)
  WHERE state_class NOT IN ('closed', 'cancelled');
CREATE UNIQUE INDEX issues_client_uuid_key
  ON app.issues (org_id, client_uuid) WHERE client_uuid IS NOT NULL;

-- ── Actions: one entity behind task, query and instruction ─────────
CREATE TABLE app.actions (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES app.projects(id) ON DELETE CASCADE,
  subtype       app.action_subtype NOT NULL DEFAULT 'task',

  title         TEXT NOT NULL,
  description   TEXT,

  -- Polymorphic: an action can hang off any record in the product.
  related_entity_type TEXT,
  related_entity_id   UUID,

  assignee_user_id UUID REFERENCES app.users(id) ON DELETE SET NULL,
  -- FR-222: an action may be assigned to a ROLE, and the first holder to
  -- accept becomes the assignee. On a site, "the engineer" is often more
  -- useful than a name.
  assignee_role_code TEXT,
  accepted_by   UUID,
  accepted_at   TIMESTAMPTZ,

  due_date      DATE,
  priority      SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),

  state_class   app.state_class NOT NULL DEFAULT 'draft',
  -- FR-223: an instruction may require acknowledgement, recorded per recipient.
  requires_acknowledgement BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,

  completed_at  TIMESTAMPTZ,
  completion_note TEXT,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,

  created_by    UUID NOT NULL,
  created_by_grant_id UUID,
  created_responsibility TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT actions_cancel_needs_reason CHECK (
    cancelled_at IS NULL OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 3)
  ),
  CONSTRAINT actions_need_an_assignee CHECK (
    assignee_user_id IS NOT NULL OR assignee_role_code IS NOT NULL
  )
);
CREATE INDEX actions_assignee_idx
  ON app.actions (org_id, assignee_user_id, due_date)
  WHERE state_class NOT IN ('closed', 'cancelled');
CREATE INDEX actions_related_idx
  ON app.actions (org_id, related_entity_type, related_entity_id)
  WHERE related_entity_id IS NOT NULL;
CREATE INDEX actions_role_queue_idx
  ON app.actions (org_id, project_id, assignee_role_code)
  WHERE assignee_user_id IS NULL AND state_class NOT IN ('closed','cancelled');

-- ── Comments, and the query-blocks-closure mechanic ────────────────
CREATE TABLE app.comments (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES app.projects(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  body          TEXT NOT NULL,

  -- FR-224: a comment marked as a QUERY starts an ageing clock and BLOCKS
  -- closure of the record until it is answered. That is the whole point — a
  -- question that can be closed around is a question that gets ignored.
  is_query      BOOLEAN NOT NULL DEFAULT false,
  addressed_to_user_id UUID REFERENCES app.users(id) ON DELETE SET NULL,
  answered_by   UUID,
  answered_at   TIMESTAMPTZ,
  answer_body   TEXT,

  author_id     UUID NOT NULL,
  author_grant_id UUID,
  author_responsibility TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX comments_entity_idx ON app.comments (org_id, entity_type, entity_id, created_at);
-- Open queries, which is what the closure guard consults.
CREATE INDEX comments_open_query_idx
  ON app.comments (org_id, entity_type, entity_id)
  WHERE is_query AND answered_at IS NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['issues','actions','comments'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON app.%I '
                   'FOR EACH ROW EXECUTE FUNCTION app.touch_row()', t, t);
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- ── An open query blocks closure (FR-224) ──────────────────────────
-- In the service layer this is a rule someone can forget on the third module
-- that closes something. Here it is a fact about the data.
CREATE OR REPLACE FUNCTION app.block_close_with_open_query() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE open_queries INTEGER;
BEGIN
  IF NEW.state_class <> 'closed' OR OLD.state_class = 'closed' THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO open_queries
  FROM app.comments c
  WHERE c.entity_type = TG_ARGV[0] AND c.entity_id = NEW.id
    AND c.is_query AND c.answered_at IS NULL;

  IF open_queries > 0 THEN
    RAISE EXCEPTION
      'This % has % unanswered question(s). Answer them before closing it.',
      TG_ARGV[0], open_queries
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER issues_block_close_with_open_query
  BEFORE UPDATE ON app.issues
  FOR EACH ROW EXECUTE FUNCTION app.block_close_with_open_query('issue');

CREATE TRIGGER actions_block_close_with_open_query
  BEFORE UPDATE ON app.actions
  FOR EACH ROW EXECUTE FUNCTION app.block_close_with_open_query('action');
