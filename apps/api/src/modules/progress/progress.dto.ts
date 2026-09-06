import { z } from 'zod';

const qty = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'A positive number, at most 4 decimals');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const recordProgressSchema = z.object({
  workItemId: z.string().uuid(),
  locationId: z.string().uuid(),
  // FR-142: a QUANTITY. There is deliberately no percentage field anywhere in
  // this schema — percentage is derived, and a field for it would invite an
  // opinion where a measurement belongs.
  reportedQty: qty,
  executedOn: isoDate.optional(),
  contractorLabel: z.string().max(120).optional(),
  note: z.string().max(1000).optional(),
  overExecutionReason: z.string().min(3).max(500).optional(),
  clientUuid: z.string().uuid().optional(),
  deviceClockSkewMs: z.coerce.number().int().optional(),
});

export const verifySchema = z.object({
  decision: z.enum(['accept', 'adjust', 'reject']),
  verifiedQty: qty.optional(),
  reason: z.string().max(500).optional(),
}).refine((v) => v.decision !== 'adjust' || !!v.verifiedQty, {
  message: 'An adjustment needs the corrected quantity', path: ['verifiedQty'],
}).refine((v) => v.decision === 'accept' || (v.reason ?? '').trim().length >= 3, {
  message: 'Adjusting or rejecting a claim needs a reason', path: ['reason'],
});

export const listProgressSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['reported', 'verified', 'adjusted', 'rejected']).optional(),
  locationId: z.string().uuid().optional(),
  workItemId: z.string().uuid().optional(),
  reportedBy: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const dailyReportSchema = z.object({
  reportDate: isoDate.optional(),
  weather: z.string().max(80).optional(),
  workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workStop: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  // Optional in the MVP: nothing consumes headcount until productivity
  // reporting arrives, and data entry with no return to the user is how a
  // supervisor learns to skip the form (AR-01).
  manpower: z.array(z.object({
    trade: z.string().min(1).max(60),
    contractor: z.string().max(120).optional(),
    count: z.coerce.number().int().min(0).max(9999),
  })).max(40).optional(),
  notes: z.string().max(4000).optional(),
  clientUuid: z.string().uuid().optional(),
});

export const amendSchema = z.object({ reason: z.string().min(5).max(500) });

export const gapSchema = z.object({
  from: isoDate.optional(), to: isoDate.optional(),
});

export const missingSchema = z.object({ from: isoDate, to: isoDate });

export const listReportsSchema = z.object({
  cursor: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();
