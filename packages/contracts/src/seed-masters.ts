import type { StateClass } from './state-classes.js';
import type { UnitDimension } from './units.js';

/**
 * Masters every new tenant receives.
 *
 * FR-544: a tenant that never opens a configuration screen must still have a
 * working system. Shipping an organization with no units means the first work
 * item cannot be created, and configurability that requires configuration
 * before first use is a failed product.
 */
export const SEED_UNITS: Array<{
  code: string; name: string; dimension: UnitDimension; decimals: number;
}> = [
  { code: 'nos', name: 'Numbers',      dimension: 'count',  decimals: 0 },
  { code: 'm',   name: 'Metre',        dimension: 'length', decimals: 2 },
  { code: 'rmt', name: 'Running metre',dimension: 'length', decimals: 2 },
  { code: 'sqm', name: 'Square metre', dimension: 'area',   decimals: 2 },
  { code: 'sft', name: 'Square foot',  dimension: 'area',   decimals: 2 },
  { code: 'cum', name: 'Cubic metre',  dimension: 'volume', decimals: 3 },
  { code: 'ltr', name: 'Litre',        dimension: 'volume', decimals: 2 },
  { code: 'kg',  name: 'Kilogram',     dimension: 'mass',   decimals: 3 },
  { code: 'mt',  name: 'Metric tonne', dimension: 'mass',   decimals: 3 },
  { code: 'bag', name: 'Bag',          dimension: 'count',  decimals: 0 },
  { code: 'day', name: 'Day',          dimension: 'time',   decimals: 1 },
  { code: 'hr',  name: 'Hour',         dimension: 'time',   decimals: 1 },
];

export const SEED_WORK_CATEGORIES = [
  { code: 'civil',      name: 'Civil' },
  { code: 'structural', name: 'Structural' },
  { code: 'finishes',   name: 'Finishes' },
  { code: 'electrical', name: 'Electrical' },
  { code: 'plumbing',   name: 'Plumbing' },
  { code: 'hvac',       name: 'HVAC' },
  { code: 'external',   name: 'External works' },
  { code: 'other',      name: 'Other' },
];

/** Issues carry quality and safety in the MVP (PRODUCT_REVIEW.md §4.3). */
export const SEED_ISSUE_CATEGORIES = [
  { code: 'quality',      name: 'Quality' },
  { code: 'safety',       name: 'Safety' },
  { code: 'design',       name: 'Design' },
  { code: 'delay',        name: 'Delay' },
  { code: 'housekeeping', name: 'Housekeeping' },
  { code: 'other',        name: 'Other' },
];

/**
 * Fixed statuses (MVP_SCOPE.md §6). Label EQUALS state class here and no editor
 * ships — the table exists so Phase 2 turns configurability on without touching
 * the schema.
 */
export const SEED_STATUSES: Array<{
  entity: string; cls: StateClass; label: string;
  isDefault?: boolean; isTerminal?: boolean;
}> = [
  { entity: 'project', cls: 'draft',       label: 'Planning', isDefault: true },
  { entity: 'project', cls: 'in_progress', label: 'Active' },
  { entity: 'project', cls: 'on_hold',     label: 'On Hold' },
  { entity: 'project', cls: 'closed',      label: 'Closed', isTerminal: true },

  { entity: 'progress_entry', cls: 'submitted', label: 'Reported', isDefault: true },
  { entity: 'progress_entry', cls: 'verified',  label: 'Verified', isTerminal: true },
  { entity: 'progress_entry', cls: 'rejected',  label: 'Rejected', isTerminal: true },

  { entity: 'daily_report', cls: 'draft',       label: 'Draft', isDefault: true },
  { entity: 'daily_report', cls: 'submitted',   label: 'Submitted' },
  { entity: 'daily_report', cls: 'in_approval', label: 'Awaiting Approval' },
  { entity: 'daily_report', cls: 'approved',    label: 'Approved', isTerminal: true },
  { entity: 'daily_report', cls: 'rejected',    label: 'Rejected' },

  { entity: 'issue', cls: 'draft',       label: 'Open', isDefault: true },
  { entity: 'issue', cls: 'in_progress', label: 'In Progress' },
  { entity: 'issue', cls: 'resolved',    label: 'Resolved' },
  { entity: 'issue', cls: 'verified',    label: 'Verified' },
  { entity: 'issue', cls: 'closed',      label: 'Closed', isTerminal: true },
  { entity: 'issue', cls: 'cancelled',   label: 'Cancelled', isTerminal: true },
];
