import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const createProjectSchema = z.object({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/,
    'Uppercase letters, digits and hyphens, 2–24 characters'),
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  clientName: z.string().max(160).optional(),
  plannedStart: isoDate.optional(),
  plannedFinish: isoDate.optional(),
  // FR-103: never empty. A project with no accountable manager is how work
  // becomes nobody's.
  accountableManagerUserId: z.string().uuid(),
  commercialOwnerUserId: z.string().uuid(),
  locationLabelScheme: z.array(z.string().min(1).max(40)).min(1).max(8)
    .default(['Block', 'Floor', 'Unit', 'Room']),
  timezone: z.string().max(64).default('Asia/Kolkata'),
});

export const updateProjectSchema = createProjectSchema.partial().omit({ code: true });

export const listProjectsSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  state: z.string().max(30).optional(),
  q: z.string().max(120).optional(),
});

export const createLocationSchema = z.object({
  parentId: z.string().uuid().nullish(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  levelName: z.string().max(40).optional(),
  attributes: z.record(z.unknown()).default({}),
  sortOrder: z.coerce.number().int().default(0),
});

/**
 * Bulk pattern creation (FR-106).
 *
 * A 14-storey tower with 6 flats and 4 rooms each is 1,176 nodes. Nobody types
 * those, so the tree is generated from a level spec: each level names itself
 * and either enumerates its children or ranges over them.
 */
export const bulkLocationsSchema = z.object({
  parentId: z.string().uuid().nullish(),
  levels: z.array(z.object({
    levelName: z.string().min(1).max(40),
    /** Explicit list, e.g. ['A','B'] for two towers. */
    items: z.array(z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
    })).optional(),
    /** Or a numeric range, e.g. floors 1–14 as 'F{n}' / 'Floor {n}'. */
    range: z.object({
      from: z.coerce.number().int().min(0).max(999),
      to: z.coerce.number().int().min(0).max(999),
      codeTemplate: z.string().min(1).max(40),   // 'F{n}'
      nameTemplate: z.string().min(1).max(120),  // 'Floor {n}'
      pad: z.coerce.number().int().min(0).max(4).default(0),
    }).optional(),
  }).refine((l) => !!l.items !== !!l.range, {
    message: 'Give a level either an explicit item list or a range, not both',
  })).min(1).max(5),
});

export const allocateSchema = z.object({
  allocations: z.array(z.object({
    locationId: z.string().uuid(),
    plannedQty: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Quantity must be a positive decimal'),
  })).min(1).max(2000),
  /** Replace clears existing allocations first; merge upserts. */
  mode: z.enum(['replace', 'merge']).default('merge'),
});

export const createWorkItemSchema = z.object({
  code: z.string().min(1).max(40),
  description: z.string().min(2).max(500),
  unitCode: z.string().min(1).max(20),
  plannedQty: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).default('0'),
  parentId: z.string().uuid().nullish(),
  workCategoryCode: z.string().max(40).optional(),
  specReference: z.string().max(200).optional(),
});

export const importPreviewSchema = z.object({
  filename: z.string().max(255).optional(),
  /** Maps our field names to the spreadsheet's column headers. */
  columnMap: z.record(z.string()).default({}),
  rows: z.array(z.record(z.string())).min(1).max(5000),
});
