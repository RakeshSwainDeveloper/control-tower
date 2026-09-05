-- ═══════════════════════════════════════════════════════════════════
-- 0019_cross_project_integrity
--
-- DEFECT: a work item in project A could be allocated to a location in
-- project B. The foreign key points at app.locations(id), and RLS confines
-- that to the TENANT — but a tenant has many projects, and nothing checked
-- that the two rows belonged to the same one.
--
-- Consequence: a location tree from one project silently contributes planned
-- quantity to another. Progress then rolls up into a project the work was
-- never part of, and the number is wrong in a way no dashboard could reveal —
-- which is precisely the failure the drill-through principle exists to prevent.
--
-- Fixed with COMPOSITE foreign keys, not a service-layer check: an import, a
-- future bulk path or a background job must not be able to route around it.
-- ═══════════════════════════════════════════════════════════════════

-- Remove anything already mis-allocated before adding the constraint.
DELETE FROM app.work_item_locations a
USING app.locations l
WHERE a.location_id = l.id AND l.project_id <> a.project_id;

DELETE FROM app.work_item_locations a
USING app.work_items w
WHERE a.work_item_id = w.id AND w.project_id <> a.project_id;

-- Composite targets. The (project_id, id) pairs are unique by construction
-- because id is already the primary key.
ALTER TABLE app.locations  ADD CONSTRAINT locations_project_id_key  UNIQUE (project_id, id);
ALTER TABLE app.work_items ADD CONSTRAINT work_items_project_id_key UNIQUE (project_id, id);

ALTER TABLE app.work_item_locations
  ADD CONSTRAINT wil_location_same_project
  FOREIGN KEY (project_id, location_id)
  REFERENCES app.locations (project_id, id) ON DELETE CASCADE;

ALTER TABLE app.work_item_locations
  ADD CONSTRAINT wil_work_item_same_project
  FOREIGN KEY (project_id, work_item_id)
  REFERENCES app.work_items (project_id, id) ON DELETE CASCADE;

-- A location's parent must be in the same project too: a tree that spans
-- projects has no meaningful root and its display path is nonsense.
ALTER TABLE app.locations
  ADD CONSTRAINT locations_parent_same_project
  FOREIGN KEY (project_id, parent_id)
  REFERENCES app.locations (project_id, id) ON DELETE RESTRICT;

-- Likewise for a work item's optional parent group.
ALTER TABLE app.work_items
  ADD CONSTRAINT work_items_parent_same_project
  FOREIGN KEY (project_id, parent_id)
  REFERENCES app.work_items (project_id, id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT wil_location_same_project ON app.work_item_locations IS
  'RLS confines a row to the tenant; this confines it to the PROJECT. Without '
  'it, planned quantity from one project rolls up into another.';
