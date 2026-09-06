/**
 * Evidence capture, on and off the network.
 *
 * The rule this file exists to keep: **a photograph is never lost because the
 * phone had no signal.** Capture writes the blob to IndexedDB first and returns
 * immediately; uploading is a separate, retryable step. A supervisor on the
 * fifth floor takes four photos, walks down, and they upload themselves.
 *
 * The server's two-phase contract (Phase 4) is presign → PUT direct to storage
 * → complete. The content hash is computed on the device so the server can
 * dedupe: the same photo attached twice costs one object, not two.
 */
import { api, ApiError } from '../api.js';
import { db } from './outbox.js';

export interface CaptureMeta {
  kind: 'photo' | 'video' | 'document';
  purpose: 'progress' | 'issue' | 'closure' | 'before' | 'after' | 'general';
  projectId?: string;
  locationId?: string;
  /** Attach on completion, so capture and attach are one round trip. */
  link?: { entityType: string; entityId: string; caption?: string };
}

export interface PendingEvidence {
  id: string;
  blob: Blob;
  mime: string;
  size: number;
  hash: string;
  capturedAt: string;
  meta: CaptureMeta;
  gps?: { lat: number; lng: number; accuracyM?: number };
  gpsUnavailableReason?: string;
  state: 'captured' | 'uploading' | 'uploaded' | 'failed';
  attempts: number;
  lastError?: string;
  serverId?: string;
  /** Object URL for the local thumbnail. Not persisted. */
  previewUrl?: string;
}

const store = new Map<string, PendingEvidence>();
const listeners = new Set<() => void>();

export function subscribeEvidence(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => { for (const l of listeners) l(); };

/** SHA-256 of the bytes, so the server can recognise a duplicate. */
async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * GPS, with a deliberate time limit.
 *
 * The database refuses a site photograph carrying neither a location nor a
 * stated reason for lacking one. Inside a concrete frame there is often no fix,
 * and a supervisor must not wait thirty seconds to find that out — so: eight
 * seconds, then record WHY there is no location and move on.
 */
function locate(): Promise<{ lat: number; lng: number; accuracyM?: number } | { reason: string }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ reason: 'Device has no location service' });
    const timer = setTimeout(
      () => resolve({ reason: 'No GPS fix within 8 seconds (indoors or shielded)' }), 8_000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          ...(pos.coords.accuracy ? { accuracyM: Math.round(pos.coords.accuracy) } : {}),
        });
      },
      (err) => { clearTimeout(timer); resolve({ reason: `Location unavailable: ${err.message}` }); },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 30_000 },
    );
  });
}

/** Capture. Returns as soon as the bytes are safe on the device. */
export async function capture(file: File, meta: CaptureMeta): Promise<PendingEvidence> {
  const id = crypto.randomUUID();
  const capturedAt = new Date().toISOString();
  const [hash, position] = await Promise.all([sha256(file), locate()]);

  const rec: PendingEvidence = {
    id, blob: file, mime: file.type || 'image/jpeg', size: file.size, hash,
    capturedAt, meta,
    ...('lat' in position ? { gps: position } : { gpsUnavailableReason: position.reason }),
    state: 'captured', attempts: 0,
    previewUrl: URL.createObjectURL(file),
  };

  store.set(id, rec);
  // Persisted too: an object URL dies with the tab, the bytes must not.
  await (await db()).put('blobs', {
    id, client_uuid: id, blob: file, mime: rec.mime, captured_at: capturedAt,
    ...(rec.gps ? { gps_lat: rec.gps.lat, gps_lng: rec.gps.lng } : {}),
    ...(rec.gpsUnavailableReason ? { gps_unavailable_reason: rec.gpsUnavailableReason } : {}),
  });
  notify();
  return rec;
}

export function pending(): PendingEvidence[] {
  return [...store.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function forget(id: string): void {
  const rec = store.get(id);
  if (rec?.previewUrl) URL.revokeObjectURL(rec.previewUrl);
  store.delete(id);
  void db().then((d) => d.delete('blobs', id));
  notify();
}

/**
 * Upload one captured item and return its server id.
 *
 * Throws on failure, having recorded the reason on the record. The caller
 * decides whether to retry now or leave it for the sync engine.
 */
export async function upload(id: string): Promise<string> {
  const rec = store.get(id);
  if (!rec) throw new Error('No such capture');
  if (rec.serverId) return rec.serverId;

  rec.state = 'uploading';
  rec.attempts += 1;
  notify();

  try {
    const presign = await api.post<{
      deduplicated: boolean;
      evidence_id: string;
      upload?: { url: string; method: string; headers?: Record<string, string> };
    }>('/evidence/presign', {
      kind: rec.meta.kind,
      purpose: rec.meta.purpose,
      mime: rec.mime,
      sizeBytes: rec.size,
      contentHash: rec.hash,
      captureMethod: 'in_app_camera',
      capturedAtDevice: rec.capturedAt,
      ...(rec.meta.projectId ? { projectId: rec.meta.projectId } : {}),
      ...(rec.meta.locationId ? { locationId: rec.meta.locationId } : {}),
      ...(rec.gps ? { gps: rec.gps } : {}),
      ...(rec.gpsUnavailableReason ? { gpsUnavailableReason: rec.gpsUnavailableReason } : {}),
      ...(rec.meta.link ? { link: rec.meta.link } : {}),
      clientUuid: rec.id,
    });

    // Already on the server, byte for byte. Nothing to upload.
    if (!presign.deduplicated && presign.upload) {
      const put = await fetch(presign.upload.url, {
        method: presign.upload.method || 'PUT',
        headers: { 'content-type': rec.mime, ...(presign.upload.headers ?? {}) },
        body: rec.blob,
      });
      if (!put.ok) throw new Error(`Storage rejected the upload (${put.status})`);
      await api.post(`/evidence/${presign.evidence_id}/complete`, {});
    }

    rec.serverId = presign.evidence_id;
    rec.state = 'uploaded';
    notify();
    return presign.evidence_id;
  } catch (e) {
    rec.state = 'failed';
    rec.lastError = e instanceof ApiError ? e.message : (e as Error).message;
    notify();
    throw e;
  }
}

/** Upload everything captured, returning the server ids that made it. */
export async function uploadAll(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    try { out.push(await upload(id)); } catch { /* left on the device to retry */ }
  }
  return out;
}

/** Attach already-uploaded evidence to a record. */
export async function link(
  evidenceId: string, entityType: string, entityId: string, caption?: string,
): Promise<void> {
  await api.post(`/evidence/${evidenceId}/link`, {
    entityType, entityId, ...(caption ? { caption } : {}),
  });
}
