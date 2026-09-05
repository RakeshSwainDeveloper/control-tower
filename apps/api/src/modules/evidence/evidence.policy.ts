import { BadRequestException } from '@nestjs/common';
import type { Env } from '../../config/env.js';

export type EvidenceKind = 'photo' | 'video' | 'document' | 'audio' | 'signature';
export type CaptureMethod = 'in_app_camera' | 'gallery' | 'desktop_upload';
export type EvidencePurpose =
  | 'progress' | 'inspection' | 'issue' | 'closure' | 'receipt'
  | 'safety' | 'before' | 'after' | 'general';

/**
 * Purposes for which the evidence is the PROOF, not an illustration.
 *
 * These attract the anti-gaming rules: in-app capture only, and a hard limit on
 * how old a gallery file may be. Re-submitting last week's photo as today's
 * progress is the most common form of evidence fraud on a site.
 */
const EVIDENTIARY_PURPOSES: ReadonlySet<EvidencePurpose> = new Set([
  'progress', 'inspection', 'closure', 'receipt', 'safety',
]);

const ALLOWED_MIME: Record<EvidenceKind, RegExp> = {
  photo: /^image\/(jpeg|png|webp|heic|heif)$/i,
  video: /^video\/(mp4|quicktime|webm)$/i,
  document: /^(application\/pdf|image\/(jpeg|png))$/i,
  audio: /^audio\/(mp4|mpeg|aac|webm|ogg)$/i,
  signature: /^image\/(png|webp)$/i,
};

export interface CaptureContext {
  kind: EvidenceKind;
  purpose: EvidencePurpose;
  mime: string;
  sizeBytes: number;
  captureMethod: CaptureMethod;
  capturedAtDevice: Date;
  originalFileTimestamp?: Date | undefined;
  gps?: { lat: number; lng: number; accuracyM?: number } | undefined;
  gpsUnavailableReason?: string | undefined;
  durationMs?: number | undefined;
}

export function isEvidentiary(purpose: EvidencePurpose): boolean {
  return EVIDENTIARY_PURPOSES.has(purpose);
}

/**
 * Everything that must be true before we hand out an upload URL.
 *
 * Validating here rather than after upload means a rejected capture never
 * consumes storage or the supervisor's bandwidth — which on one bar of 3G is
 * the difference between a refusal and a lost afternoon.
 */
export function assertCaptureAllowed(ctx: CaptureContext, env: Env): void {
  const allowed = ALLOWED_MIME[ctx.kind];
  if (!allowed.test(ctx.mime)) {
    throw new BadRequestException(
      `${ctx.mime} is not an accepted type for ${ctx.kind}`,
    );
  }

  const maxBytes = ctx.kind === 'video'
    ? env.EVIDENCE_MAX_VIDEO_BYTES
    : env.EVIDENCE_MAX_PHOTO_BYTES;
  if (ctx.sizeBytes > maxBytes) {
    throw new BadRequestException(
      `That ${ctx.kind} is ${mb(ctx.sizeBytes)}; the limit is ${mb(maxBytes)}. ` +
        (ctx.kind === 'photo'
          ? 'Photos are compressed on the device before upload.'
          : 'Record a shorter clip.'),
    );
  }

  if (ctx.kind === 'video' && ctx.durationMs != null) {
    const maxMs = env.EVIDENCE_MAX_VIDEO_SECONDS * 1000;
    if (ctx.durationMs > maxMs) {
      throw new BadRequestException(
        `That clip is ${Math.round(ctx.durationMs / 1000)}s; the limit is ` +
          `${env.EVIDENCE_MAX_VIDEO_SECONDS}s.`,
      );
    }
  }

  if (isEvidentiary(ctx.purpose)) {
    // FR-175: for evidentiary purposes the capture must happen in the app.
    if (ctx.captureMethod === 'gallery') {
      const window = env.EVIDENCE_GALLERY_MAX_AGE_HOURS;
      const ts = ctx.originalFileTimestamp;
      if (!ts) {
        throw new BadRequestException(
          `A gallery file used as ${ctx.purpose} evidence must carry its original ` +
            'capture time. Take the photo in the app instead.',
        );
      }
      // FR-176 / BR-12.
      const ageHours = (Date.now() - ts.getTime()) / 3_600_000;
      if (ageHours > window) {
        throw new BadRequestException(
          `That file was captured ${Math.round(ageHours)} hours ago; ` +
            `${ctx.purpose} evidence must be no more than ${window} hours old. ` +
            'Take a new photo in the app.',
        );
      }
      if (ageHours < -1) {
        // A future timestamp means the device clock is wrong or the file was
        // edited. Either way it is not evidence of anything.
        throw new BadRequestException(
          'That file is timestamped in the future. Check the device date.',
        );
      }
    }

    // FR-182: a missing fix is permitted and RECORDED WITH ITS REASON. It is
    // never silently stored as 0,0, and it is never simply absent.
    if (!ctx.gps && !ctx.gpsUnavailableReason) {
      throw new BadRequestException(
        `${ctx.purpose} evidence needs a location. If the device cannot get a ` +
          'fix, send gps_unavailable_reason so the verifier can see why.',
      );
    }
  }

  if (ctx.gps) {
    const { lat, lng } = ctx.gps;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new BadRequestException('Those coordinates are not on Earth');
    }
    if (lat === 0 && lng === 0) {
      // The classic "GPS failed and something wrote zeroes" signature.
      throw new BadRequestException(
        'Coordinates 0,0 are a failed fix, not a location. Send ' +
          'gps_unavailable_reason instead.',
      );
    }
  }
}

/** Device clock skew beyond this is recorded and flagged to the verifier. */
export const CLOCK_SKEW_FLAG_MS = 5 * 60 * 1000;

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
