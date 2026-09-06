/**
 * The client half of the sync contract built in Phase 4.
 *
 * The server owns idempotency, conflict policy and the needs-attention queue.
 * This file owns only: when to try, how many at a time, and what to do with
 * each result. It deliberately contains no conflict logic of its own — a
 * device deciding conflicts from a stale copy is the failure this whole design
 * exists to prevent.
 */
import { api, ApiError } from '../api.js';
import * as outbox from './outbox.js';

/** The server caps a batch at 200. Stay well under it on a phone on 2G. */
const BATCH = 25;
const BACKOFF_MS = [0, 2_000, 10_000, 30_000, 120_000, 300_000];

export type SyncState = 'idle' | 'offline' | 'syncing' | 'attention';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  attention: number;
  lastSyncAt: number | null;
  oldestPendingAt: number | null;
  lastError?: string;
}

interface WireResult {
  client_uuid: string;
  status: 'accepted' | 'conflict' | 'rejected';
  server_id?: string | null;
  server_number?: string | null;
  conflict?: { policy: string; kept_both: boolean; other_id?: string | null; detail?: string };
  reason?: string;
}

let running = false;
let lastSyncAt: number | null = null;
let lastError: string | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<(s: SyncStatus) => void>();

export function onStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  void emit();
  return () => listeners.delete(fn);
}

async function emit(): Promise<void> {
  const [pending, attention] = await Promise.all([outbox.unsent(), outbox.needsAttention()]);
  const status: SyncStatus = {
    state: running ? 'syncing'
      : attention.length > 0 ? 'attention'
      : !navigator.onLine ? 'offline'
      : 'idle',
    pending: pending.length,
    attention: attention.length,
    lastSyncAt,
    oldestPendingAt: pending.length > 0 ? pending[0]!.queued_at : null,
    ...(lastError ? { lastError } : {}),
  };
  for (const l of listeners) l(status);
}

/**
 * Drain what is queued.
 *
 * Safe to call at any time, from anywhere. It is a no-op while a drain is
 * already running and while the device is offline, so screens can call it on
 * mount, on focus and on a button without coordinating.
 */
export async function flush(): Promise<void> {
  if (running || !navigator.onLine) { await emit(); return; }
  const queued = await outbox.unsent();
  if (queued.length === 0) { await emit(); return; }

  running = true;
  lastError = undefined;
  await emit();

  try {
    for (let i = 0; i < queued.length; i += BATCH) {
      const slice = queued.slice(i, i + BATCH);
      // Attempts are recorded BEFORE the send: a request that never returns
      // must still count, or a persistently failing item retries forever at
      // full speed and flattens the battery.
      await Promise.all(slice.map((it) =>
        outbox.update(it.client_uuid, { state: 'sending', attempts: it.attempts + 1 })));

      let results: WireResult[];
      try {
        const res = await api.post<{ results: WireResult[] }>('/sync/batch', {
          items: slice.map((it) => ({
            client_uuid: it.client_uuid,
            entity: it.entity,
            op: it.op,
            payload: it.payload,
            device_ts: it.device_ts,
            ...(it.base_version !== undefined ? { base_version: it.base_version } : {}),
          })),
        });
        results = res.results;
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        lastError = err?.message ?? 'Sync failed';
        // status 0 is a dead network: put everything back and wait. A 4xx on
        // the batch itself is a client bug, not a per-item outcome, so the
        // items also go back rather than being silently dropped.
        await Promise.all(slice.map((it) =>
          outbox.update(it.client_uuid, { state: 'pending', last_error: lastError })));
        break;
      }

      for (const r of results) {
        if (r.status === 'accepted') {
          await outbox.acknowledge(r.client_uuid);
        } else if (r.status === 'conflict') {
          // Kept by the server under keep_both_and_flag, or surfaced for a
          // human. Either way it is resolved in Needs Attention, not here.
          await outbox.update(r.client_uuid, {
            state: 'conflict',
            ...(r.server_id ? { server_id: r.server_id } : {}),
            last_error: r.conflict?.detail ?? 'Someone else changed this while you were offline.',
          });
        } else {
          await outbox.update(r.client_uuid, {
            state: 'attention',
            last_error: r.reason ?? 'The server could not accept this.',
          });
        }
      }
    }
    lastSyncAt = Date.now();
  } finally {
    running = false;
    await emit();
    schedule();
  }
}

/** Retry with backoff while anything is still queued. */
function schedule(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  void outbox.unsent().then((q) => {
    if (q.length === 0) return;
    const attempts = Math.min(...q.map((i) => i.attempts));
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 300_000;
    timer = setTimeout(() => { void flush(); }, Math.max(wait, 2_000));
  });
}

/** Wire the engine to the browser. Called once, from the app root. */
export function startSyncEngine(): () => void {
  const onOnline = () => { void flush(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void flush(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', () => { void emit(); });
  document.addEventListener('visibilitychange', onVisible);
  const unsubOutbox = outbox.subscribe(() => { void emit(); });
  void flush();
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    unsubOutbox();
    if (timer) clearTimeout(timer);
  };
}
