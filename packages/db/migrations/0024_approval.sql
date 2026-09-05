-- ═══════════════════════════════════════════════════════════════════
-- 0024_approval   ·   PHASE 6 · M9
--
-- ONE engine, not fourteen implementations.
--
-- The reference FRD specified approval rules separately for POs, payments, RA
-- bills and variations, with nearly identical text each time — which guarantees
-- they drift apart within a year. Modules submit an object to the engine and
-- react to the outcome; they contain no approval logic of their own.
--
-- The MVP engine is deliberately small (sequential, two resolvers, two object
-- types) but its SHAPE is the full one, so Phase 3's money objects arrive as
-- configuration rather than code.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE app.approval_decision AS ENUM (
  'approve', 'reject', 'hold', 'query', 'reversal'
);

CREATE TYPE app.approval_step_status AS ENUM (
  'pending', 'in_progress', 'completed', 'skipped', 'blocked'
);

CREATE TYPE app.approval_task_status AS ENUM (
  'pending', 'decided', 'withdrawn', 'superseded'
);

CREATE TYPE app.approver_resolver AS ENUM (
  -- Whoever holds role R, scoped to this object's project.
  'role_in_project',
  -- The project's designated accountable manager.
  'project_manager'
  -- Phase 3 adds: specific_user, company_role, authority_band, approval_group.
);

-- ── Definition: which object type routes how, at which scope ───────
CREATE TABLE app.approval_definitions (
  id           UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id       UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  object_type  TEXT NOT NULL,
  scope_type   app.scope_type NOT NULL DEFAULT 'org',
  scope_id     UUID,
  name         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  version      INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT approval_definitions_scope_shape CHECK (
    (scope_type = 'org' AND scope_id IS NULL) OR
    (scope_type <> 'org' AND scope_id IS NOT NULL)
  )
);
-- One ACTIVE definition per object type per scope. Two would make routing
-- non-deterministic, and "which one applied" is the first question in any
-- dispute about an approval.
CREATE UNIQUE INDEX approval_definitions_one_active
  ON app.approval_definitions (org_id, object_type, scope_type,
                               COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

-- ── Version: IMMUTABLE once activated ──────────────────────────────
-- BR-20. Without this, changing a threshold on Tuesday retroactively
-- reinterprets every approval made on Monday, and the audit trail becomes
-- unreadable. The spec is stored whole so an instance can be replayed exactly
-- as it ran.
CREATE TABLE app.approval_versions (
  id             UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id         UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  definition_id  UUID NOT NULL REFERENCES app.approval_definitions(id) ON DELETE CASCADE,
  version_no     INTEGER NOT NULL,
  -- [{ step_no, name, resolver, role_code?, sla_hours, is_mandatory }]
  spec           JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by   UUID,
  activated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version_no)
);

-- ── Instance: one per submitted object ─────────────────────────────
CREATE TABLE app.approval_instances (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES app.projects(id) ON DELETE CASCADE,
  object_type   TEXT NOT NULL,
  object_id     UUID NOT NULL,

  definition_id UUID NOT NULL REFERENCES app.approval_definitions(id),
  version_id    UUID NOT NULL REFERENCES app.approval_versions(id),
  -- The snapshot. The instance completes under the version it STARTED on,
  -- whatever the definition says later.
  spec_snapshot JSONB NOT NULL,

  -- Declared and unused in the MVP: no money (PRODUCT_REVIEW.md §14).
  -- Phase 3 populates these and amount-band routing activates.
  amount        BIGINT,
  currency      CHAR(3),
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,

  status        TEXT NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress','approved','rejected','withdrawn',
                                  'on_hold','query_raised','blocked')),
  state_class   app.state_class NOT NULL DEFAULT 'in_approval',
  current_step  INTEGER NOT NULL DEFAULT 1,

  submitted_by  UUID NOT NULL,
  submitted_by_grant_id UUID,
  submitted_responsibility TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT approval_instances_no_money_in_mvp CHECK (amount IS NULL AND currency IS NULL)
);
-- An object can have at most one LIVE instance. A resubmission after rejection
-- creates a new one; two live instances on one object would mean two answers.
CREATE UNIQUE INDEX approval_instances_one_live
  ON app.approval_instances (org_id, object_type, object_id)
  WHERE status IN ('in_progress', 'on_hold', 'query_raised');
CREATE INDEX approval_instances_object_idx
  ON app.approval_instances (org_id, object_type, object_id);
CREATE INDEX approval_instances_open_idx
  ON app.approval_instances (org_id, project_id, submitted_at)
  WHERE status IN ('in_progress', 'on_hold', 'query_raised', 'blocked');

-- ── Step instances ─────────────────────────────────────────────────
CREATE TABLE app.approval_step_instances (
  id            UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  instance_id   UUID NOT NULL REFERENCES app.approval_instances(id) ON DELETE CASCADE,
  step_no       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  resolver      app.approver_resolver NOT NULL,
  role_code     TEXT,
  sla_hours     INTEGER,
  status        app.approval_step_status NOT NULL DEFAULT 'pending',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  sla_due_at    TIMESTAMPTZ,
  -- SoD-04: when routing resolves two steps to the same person, the step
  -- collapses to one decision and records that it did. Silently letting one
  -- person tick two boxes is the worst outcome; collapsing it visibly is
  -- honest and keeps the record moving.
  collapsed_from_step_no INTEGER,
  UNIQUE (instance_id, step_no)
);
CREATE INDEX approval_steps_instance_idx ON app.approval_step_instances (org_id, instance_id, step_no);

-- ── Tasks: one per resolved approver ───────────────────────────────
CREATE TABLE app.approval_tasks (
  id              UUID PRIMARY KEY DEFAULT app.uuid_v7(),
  org_id          UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  project_id      UUID,
  instance_id     UUID NOT NULL REFERENCES app.approval_instances(id) ON DELETE CASCADE,
  step_instance_id UUID NOT NULL REFERENCES app.approval_step_instances(id) ON DELETE CASCADE,
  assignee_user_id UUID NOT NULL,
  assignee_grant_id UUID,
  status          app.approval_task_status NOT NULL DEFAULT 'pending',
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sla_due_at      TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,
  -- Declared for Phase 3 delegation; the column exists so enabling it is data.
  delegated_from_user_id UUID
);
-- THE approvals inbox (FR-199). Partial and assignee-leading, because "what is
-- waiting on me" is the query every approver runs and nothing else matters here.
CREATE INDEX approval_tasks_inbox_idx
  ON app.approval_tasks (org_id, assignee_user_id, assigned_at)
  WHERE status = 'pending';
CREATE INDEX approval_tasks_instance_idx ON app.approval_tasks (org_id, instance_id);

-- ── Decisions: APPEND ONLY ─────────────────────────────────────────
-- FR-205. A decision is never edited. A reversal is a NEW decision with a
-- mandatory reason, and both appear on the timeline in sequence.
CREATE TABLE app.approval_decisions (
  id            UUID NOT NULL DEFAULT app.uuid_v7(),
  org_id        UUID NOT NULL,
  instance_id   UUID NOT NULL,
  task_id       UUID,
  step_no       INTEGER NOT NULL,
  decision      app.approval_decision NOT NULL,
  comment       TEXT,
  decided_by    UUID NOT NULL,
  decided_by_grant_id UUID,
  -- FR-030. "Vikram approved this" is ambiguous when he holds four
  -- responsibilities. "as Project Manager" is not.
  responsibility_label TEXT,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            INET,
  device        TEXT,
  -- Declared for Phase 3; auto-advance is off by default and, when used, is
  -- attributed to the RULE, never to a person.
  is_auto_advance BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id, decided_at),
  CONSTRAINT approval_decisions_reason_required CHECK (
    decision NOT IN ('reject', 'reversal')
    OR (comment IS NOT NULL AND length(btrim(comment)) >= 3)
  )
) PARTITION BY RANGE (decided_at);

COMMENT ON TABLE app.approval_decisions IS
  'APPEND ONLY. No UPDATE path exists in the service layer and none should. A '
  'reversal is a new decision with a reason; both stay on the timeline.';

CREATE INDEX approval_decisions_instance_idx
  ON app.approval_decisions (org_id, instance_id, decided_at);
CREATE INDEX approval_decisions_actor_idx
  ON app.approval_decisions (org_id, decided_by, decided_at DESC);

CREATE TRIGGER approval_definitions_touch BEFORE UPDATE ON app.approval_definitions
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER approval_instances_touch BEFORE UPDATE ON app.approval_instances
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_definitions','approval_versions','approval_instances',
    'approval_step_instances','approval_tasks','approval_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I '
      'USING (org_id = app.current_org_id()) '
      'WITH CHECK (org_id = app.current_org_id())', t);
  END LOOP;
END $$;

-- Decisions are append-only at the GRANT level too, exactly like audit_log.
-- The service layer could enforce this; the database is what makes it true.
DO $$
DECLARE app_role TEXT := COALESCE(NULLIF(current_setting('ct.app_role', true), ''), 'ct_app');
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON app.approval_decisions FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON app.approval_decisions TO %I', app_role);
END $$;

DO $$
DECLARE m DATE;
BEGIN
  FOR m IN SELECT generate_series(
      date_trunc('month', now())::date - INTERVAL '1 month',
      date_trunc('month', now())::date + INTERVAL '3 months',
      INTERVAL '1 month')::date
  LOOP
    PERFORM app.ensure_month_partition('app.approval_decisions'::regclass, m);
  END LOOP;
END $$;
