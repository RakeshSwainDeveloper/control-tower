import { z } from 'zod';

export const presignSchema = z.object({
  kind: z.enum(['photo', 'video', 'document', 'audio', 'signature']),
  purpose: z.enum(['progress', 'inspection', 'issue', 'closure', 'receipt',
                   'safety', 'before', 'after', 'general']).default('general'),
  mime: z.string().min(3).max(120),
  sizeBytes: z.coerce.number().int().min(1).max(200 * 1024 * 1024),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i, 'Expected a SHA-256 hex digest'),
  captureMethod: z.enum(['in_app_camera', 'gallery', 'desktop_upload']),
  capturedAtDevice: z.coerce.date(),
  originalFileTimestamp: z.coerce.date().optional(),
  projectId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  gps: z.object({
    lat: z.coerce.number(), lng: z.coerce.number(),
    accuracyM: z.coerce.number().optional(),
  }).optional(),
  gpsUnavailableReason: z.string().max(120).optional(),
  durationMs: z.coerce.number().int().optional(),
  width: z.coerce.number().int().optional(),
  height: z.coerce.number().int().optional(),
  deviceModel: z.string().max(80).optional(),
  appVersion: z.string().max(40).optional(),
  clientUuid: z.string().uuid().optional(),
  /** Optional: link on completion, so capture and attach are one round trip. */
  link: z.object({
    entityType: z.string().min(2).max(60),
    entityId: z.string().uuid(),
    caption: z.string().max(500).optional(),
  }).optional(),
});

export const completeSchema = z.object({
  uploadId: z.string().max(400).optional(),
  parts: z.array(z.object({
    part_number: z.coerce.number().int().min(1),
    etag: z.string().min(1).max(200),
  })).optional(),
});

export const linkSchema = z.object({
  entityType: z.string().min(2).max(60),
  entityId: z.string().uuid(),
  purpose: z.enum(['progress', 'inspection', 'issue', 'closure', 'receipt',
                   'safety', 'before', 'after', 'general']).default('general'),
  locationId: z.string().uuid().optional(),
  caption: z.string().max(500).optional(),
  sortOrder: z.coerce.number().int().default(0),
});

export const unlinkSchema = z.object({
  // FR-172: removal is a reasoned, audited act. A blank reason turns the audit
  // trail into a list of disappearances.
  reason: z.string().min(3).max(500),
});

export const listEvidenceSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  projectId: z.string().uuid().optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().uuid().optional(),
  purpose: z.string().max(30).optional(),
  locationId: z.string().uuid().optional(),
});
