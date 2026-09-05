import { z } from 'zod';

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const raiseIssueSchema = z.object({
  title: z.string().trim().min(3).max(200),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  categoryCode: z.string().trim().max(64).optional(),
  description: z.string().trim().max(4000).optional(),
  locationId: uuid.optional(),
  workItemId: uuid.optional(),
  contractorLabel: z.string().trim().max(200).optional(),
  assigneeUserId: uuid.optional(),
  dueDate: day.optional(),
}).strict();

export const assignIssueSchema = z.object({
  assigneeUserId: uuid,
  dueDate: day.optional(),
}).strict();

export const resolveIssueSchema = z.object({
  note: z.string().trim().min(3).max(2000),
}).strict();

export const reopenIssueSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
}).strict();

export const listIssuesSchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  state: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  assigneeUserId: uuid.optional(),
  locationId: uuid.optional(),
  overdue: z.coerce.boolean().optional(),
}).strict();

export const createActionSchema = z.object({
  subtype: z.enum(['task', 'query', 'instruction']),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  relatedEntityType: z.string().trim().max(64).optional(),
  relatedEntityId: uuid.optional(),
  assigneeUserId: uuid.optional(),
  assigneeRoleCode: z.string().trim().max(64).optional(),
  dueDate: day.optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  requiresAcknowledgement: z.boolean().optional(),
}).strict();

export const completeActionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
}).strict();

export const cancelActionSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
}).strict();

export const commentSchema = z.object({
  entityType: z.enum(['issue', 'action', 'progress_entry', 'daily_report', 'work_item']),
  entityId: uuid,
  body: z.string().trim().min(1).max(4000),
  isQuery: z.boolean().optional(),
  addressedToUserId: uuid.optional(),
}).strict();

export const answerSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
}).strict();

export const threadSchema = z.object({
  entityType: z.string().trim().max(64),
  entityId: uuid,
}).strict();

export const myWorkSchema = z.object({
  projectId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/* ── Approval ── */

export const submitApprovalSchema = z.object({
  objectType: z.string().trim().min(1).max(64),
  objectId: uuid,
  projectId: uuid,
  context: z.record(z.unknown()).optional(),
}).strict();

export const decideSchema = z.object({
  // 'reversal' is deliberately not offered on this endpoint: undoing a decision
  // that has already taken effect is a separate, audited act, not a fourth
  // button next to Approve.
  decision: z.enum(['approve', 'reject', 'hold', 'query']),
  comment: z.string().trim().max(2000).optional(),
}).strict();

export const inboxSchema = z.object({
  projectId: uuid.optional(),
  objectType: z.string().trim().max(64).optional(),
}).strict();
