import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/** Quantities are decimal strings + a unit. Never floats. (D-9) */
export const quantitySchema = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'quantity must be a decimal with at most 4 places');

/** Keyset pagination — the only pagination allowed on append-heavy lists.
 *  (FR-515/516: client-side pagination is forbidden anywhere.) */
export const paginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().max(120).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Drill-through contract — FR-521/522.
 * Every aggregate the API returns must carry its definition, its as-of time,
 * and the query that reproduces it from source records. A metric whose
 * definition cannot be stated is not shipped.
 */
export interface Metric {
  metric: string;
  value: number | string | null;
  unit?: string;
  as_of: string;
  definition: string;
  source_lag_seconds?: number;
  drill: { endpoint: string; params: Record<string, string | number | boolean> };
}

/** RFC 7807 problem detail. Every error carries a support reference. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  support_reference: string;
  errors?: { path: string; message: string }[];
}
