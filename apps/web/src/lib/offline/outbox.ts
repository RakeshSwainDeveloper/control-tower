/**
 * The offline outbox.
 *
 * A supervisor on the fifth floor of a concrete frame has no signal. The
 * product's core promise is that this changes nothing about their day: they
 * record work, it is saved, and it arrives when the phone next sees a network.
 *
 * Design rules this file exists to keep:
 *
 *  · `client_uuid` is minted ON THE DEVICE, at the moment of capture, and never
 *    regenerated. It is the idempotency key the server dedupes on, so a retry
 *    after a timeout cannot create a second entry (Phase 4, PT-1).
 *  · Nothing is ever deleted because a send failed. An item leaves the outbox
 *    only when the server has acknowledged it by client_uuid.
 *  · Offline is a badge, never an error dialog (UI_UX_PLAN §3.5). Failures
 *    become a state on a row, not an interruption.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type OutboxState = 'pending' | 'sending' | 'sent' | 'conflict' | 'attention';

export interface OutboxItem {
  client_uuid: string;
  entity: string;
  op: 'create' | 'update' | 'transition';
  payload: Record<string, unknown>;
  device_ts: string;
  base_version?: number;
  /** What the user should see in the list while this is queued. */
  label: string;
  project_id: string | null;
  state: OutboxState;
  attempts: number;
  last_error?: string;
  server_id?: string;
  server_number?: string;
  queued_at: number;
  updated_at: number;
}

/** A blob captured offline, held until its evidence upload can run. */
export interface PendingBlob {
  id: string;
  client_uuid: string;
  blob: Blob;
  mime: string;
  captured_at: string;
  gps_lat?: number;
  gps_lng?: number;
  gps_unavailable_reason?: string;
}

interface CtDB extends DBSchema {
  outbox: { key: string; value: OutboxItem; indexes: { by_state: string; by_queued: number } };
  blobs:  { key: string; value: PendingBlob; indexes: { by_client_uuid: string } };
  cache:  { key: string; value: { key: string; data: unknown; at: number } };
}

let dbp: Promise<IDBPDatabase<CtDB>> | null = null;

export function db(): Promise<IDBPDatabase<CtDB>> {
  dbp ??= openDB<CtDB>('control-tower', 1, {
    upgrade(d) {
      const o = d.createObjectStore('outbox', { keyPath: 'client_uuid' });
      o.createIndex('by_state', 'state');
      o.createIndex('by_queued', 'queued_at');
      const b = d.createObjectStore('blobs', { keyPath: 'id' });
      b.createIndex('by_client_uuid', 'client_uuid');
      d.createObjectStore('cache', { keyPath: 'key' });
    },
  });
  return dbp;
}

/** Queue one operation. Returns the client_uuid the UI should show. */
export async function enqueue(input: {
  entity: string;
  op?: 'create' | 'update' | 'transition';
  payload: Record<string, unknown>;
  label: string;
  projectId?: string | null;
  baseVersion?: number;
  clientUuid?: string;
}): Promise<string> {
  const now = Date.now();
  const item: OutboxItem = {
    // Minted here, once. Everything downstream depends on this not changing.
    client_uuid: input.clientUuid ?? crypto.randomUUID(),
    entity: input.entity,
    op: input.op ?? 'create',
    payload: input.payload,
    device_ts: new Date(now).toISOString(),
    ...(input.baseVersion !== undefined ? { base_version: input.baseVersion } : {}),
    label: input.label,
    project_id: input.projectId ?? null,
    state: 'pending',
    attempts: 0,
    queued_at: now,
    updated_at: now,
  };
  await (await db()).put('outbox', item);
  notify();
  return item.client_uuid;
}

export async function attachBlob(clientUuid: string, blob: Blob, meta: {
  mime: string; capturedAt: string;
  gpsLat?: number; gpsLng?: number; gpsUnavailableReason?: string;
}): Promise<string> {
  const rec: PendingBlob = {
    id: crypto.randomUUID(),
    client_uuid: clientUuid,
    blob, mime: meta.mime, captured_at: meta.capturedAt,
    ...(meta.gpsLat !== undefined ? { gps_lat: meta.gpsLat } : {}),
    ...(meta.gpsLng !== undefined ? { gps_lng: meta.gpsLng } : {}),
    ...(meta.gpsUnavailableReason !== undefined
      ? { gps_unavailable_reason: meta.gpsUnavailableReason } : {}),
  };
  await (await db()).put('blobs', rec);
  notify();
  return rec.id;
}

export async function all(): Promise<OutboxItem[]> {
  const items = await (await db()).getAll('outbox');
  return items.sort((a, b) => a.queued_at - b.queued_at);
}

export async function unsent(): Promise<OutboxItem[]> {
  return (await all()).filter((i) => i.state === 'pending' || i.state === 'sending');
}

export async function needsAttention(): Promise<OutboxItem[]> {
  return (await all()).filter((i) => i.state === 'attention' || i.state === 'conflict');
}

export async function update(clientUuid: string, patch: Partial<OutboxItem>): Promise<void> {
  const d = await db();
  const existing = await d.get('outbox', clientUuid);
  if (!existing) return;
  await d.put('outbox', { ...existing, ...patch, updated_at: Date.now() });
  notify();
}

/**
 * Remove an acknowledged item.
 *
 * Called only with a server acknowledgement in hand. There is deliberately no
 * "clear the queue" path: an item the server has not confirmed is somebody's
 * unrecorded morning, and the product does not get to throw that away.
 */
export async function acknowledge(clientUuid: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['outbox', 'blobs'], 'readwrite');
  await tx.objectStore('outbox').delete(clientUuid);
  const blobStore = tx.objectStore('blobs');
  for (const b of await blobStore.index('by_client_uuid').getAllKeys(clientUuid)) {
    await blobStore.delete(b);
  }
  await tx.done;
  notify();
}

export async function blobsFor(clientUuid: string): Promise<PendingBlob[]> {
  return (await db()).getAllFromIndex('blobs', 'by_client_uuid', clientUuid);
}

export async function discard(clientUuid: string): Promise<void> {
  // Only reachable from Needs Attention, where the user has read the reason
  // and chosen to drop it. Never automatic.
  await acknowledge(clientUuid);
}

/* ── Read-through cache for reference data ────────────────────────
   Locations, work items and units must be pickable with no network. Small,
   slow-changing, and useless to the user if absent — exactly what belongs in
   a cache rather than a request. */
export async function putCache(key: string, data: unknown): Promise<void> {
  await (await db()).put('cache', { key, data, at: Date.now() });
}
export async function getCache<T>(key: string): Promise<{ data: T; at: number } | null> {
  const rec = await (await db()).get('cache', key);
  return rec ? { data: rec.data as T, at: rec.at } : null;
}

/* ── Change notification ──────────────────────────────────────── */
type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() { for (const l of listeners) l(); }
