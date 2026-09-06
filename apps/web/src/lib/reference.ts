/**
 * Locations, work items and units — cached on the device.
 *
 * These change slowly and are useless to a supervisor if absent: with no
 * location list there is nothing to record against. So they are read through a
 * cache that survives being offline, and refreshed opportunistically when a
 * network appears.
 *
 * "Recents" lives here too. It is the single highest-value thing in the whole
 * site experience: a supervisor works in the same four flats all week, and a
 * picker that remembers turns a scroll through 168 locations into one tap.
 */
import { api } from './api.js';
import { getCache, putCache } from './offline/outbox.js';

export interface LocationNode {
  id: string; parent_id: string | null; code: string; name: string;
  level_name: string | null; display_path: string; depth: number;
}
export interface WorkItemRef {
  id: string; code: string; description: string;
  unit_code?: string; unit_id?: string; planned_qty: string;
}

const RECENT_LOCATIONS = 'ct.recent.locations';
const RECENT_WORK = 'ct.recent.work';
const RECENT_CONTRACTOR = 'ct.recent.contractor';
const MAX_RECENT = 6;

async function readThrough<T>(key: string, path: string): Promise<{ data: T[]; stale: boolean }> {
  const cached = await getCache<T[]>(key);
  try {
    const fresh = await api.get<{ data: T[] }>(path);
    await putCache(key, fresh.data ?? []);
    return { data: fresh.data ?? [], stale: false };
  } catch {
    // Offline, or the server is down. The cache is the answer, and the caller
    // is told it is a cached answer so the screen can say so.
    return { data: cached?.data ?? [], stale: true };
  }
}

export const reference = {
  locations: (projectId: string) =>
    readThrough<LocationNode>(`locations:${projectId}`, `/projects/${projectId}/locations`),

  workItems: (projectId: string) =>
    readThrough<WorkItemRef>(`work:${projectId}`, `/projects/${projectId}/work-items?limit=500`),
};

/* ── Recents ────────────────────────────────────────────────────
   localStorage, not IndexedDB: tiny, synchronous, and read on every render of
   the picker. Losing them costs a supervisor one extra tap, not any work. */

function readRecent(key: string): string[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; }
  catch { return []; }
}
function pushRecent(key: string, id: string): void {
  try {
    const next = [id, ...readRecent(key).filter((x) => x !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* private mode; recents are a convenience, never a requirement */ }
}

export const recents = {
  locations: () => readRecent(RECENT_LOCATIONS),
  rememberLocation: (id: string) => pushRecent(RECENT_LOCATIONS, id),
  workItems: () => readRecent(RECENT_WORK),
  rememberWorkItem: (id: string) => pushRecent(RECENT_WORK, id),
  contractor: () => localStorage.getItem(RECENT_CONTRACTOR) ?? '',
  rememberContractor: (name: string) => {
    try { localStorage.setItem(RECENT_CONTRACTOR, name); } catch { /* ignore */ }
  },
};

/** Order a list so the recently used come first, in recency order. */
export function recentFirst<T extends { id: string }>(items: T[], recentIds: string[]): {
  recent: T[]; rest: T[];
} {
  const byId = new Map(items.map((i) => [i.id, i]));
  const recent = recentIds.map((id) => byId.get(id)).filter((x): x is T => !!x);
  const seen = new Set(recent.map((r) => r.id));
  return { recent, rest: items.filter((i) => !seen.has(i.id)) };
}
