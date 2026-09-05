/** Unit dimensions. Arithmetic across dimensions is blocked (FR-085):
 *  adding square metres to cubic metres is a category error, not a rounding one. */
export const UNIT_DIMENSIONS = ['length', 'area', 'volume', 'mass', 'count', 'time'] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];
