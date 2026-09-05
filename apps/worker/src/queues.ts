/**
 * Queue registry. One place so the API (producer) and worker (consumer)
 * cannot drift on names or payload shapes.
 *
 * MVP jobs only — MVP_SCOPE.md §4 M12. No digests, no WhatsApp, no rule engine.
 */
import { z } from 'zod';

export const QUEUES = {
  notifications: 'notifications',
  evidence: 'evidence',
  reports: 'reports',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** The 12 fixed notification events (MVP_SCOPE.md §5). Fixed in code, not
 *  configurable — there is no rule engine in the MVP. */
export const NOTIFICATION_EVENTS = [
  'progress.awaiting_verification',
  'progress.rejected',
  'daily_report.submitted',
  'daily_report.missing',
  'approval.required',
  'approval.decided',
  'approval.overdue',
  'query.raised',
  'issue.assigned',
  'issue.overdue',
  'issue.awaiting_verification',
  'project.weekly_summary',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const notificationJobSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  orgId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  correlationId: z.string(),
});
export type NotificationJob = z.infer<typeof notificationJobSchema>;

export const maintenanceJobSchema = z.object({
  task: z.enum(['ensure_partitions', 'sweep_overdue', 'purge_sync_operations']),
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;
