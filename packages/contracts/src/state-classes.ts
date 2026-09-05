/**
 * System state classes — FIXED IN CODE. (FR-541, MVP_DATABASE_SCOPE.md §4)
 *
 * Tenants may rename and reorder *statuses*; every status maps to exactly one
 * of these classes. All business rules, permission checks, reports and indexes
 * reason about the CLASS. Only the UI reads the label.
 *
 * This is the restraint that makes "dynamic statuses" safe: without it, code
 * cannot know which of a tenant's statuses means "approved", and no rule such
 * as "editing is not permitted after approval" can be written.
 */
export const STATE_CLASSES = [
  'draft',
  'submitted',
  'in_review',
  'in_approval',
  'approved',
  'rejected',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'cancelled',
  'on_hold',
  'void',
] as const;

export type StateClass = (typeof STATE_CLASSES)[number];

/** Classes from which a record may no longer be edited by its author. */
export const TERMINAL_CLASSES: readonly StateClass[] = [
  'approved', 'rejected', 'closed', 'cancelled', 'void',
];

/** Classes that mean "still needs someone to do something". */
export const OPEN_CLASSES: readonly StateClass[] = [
  'draft', 'submitted', 'in_review', 'in_approval', 'in_progress', 'resolved', 'on_hold',
];

export function isTerminal(c: StateClass): boolean {
  return TERMINAL_CLASSES.includes(c);
}
export function isOpen(c: StateClass): boolean {
  return OPEN_CLASSES.includes(c);
}
