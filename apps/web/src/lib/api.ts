/**
 * The HTTP client.
 *
 * Three jobs, and nothing else: attach the access token, refresh it once when
 * it expires, and turn the server's RFC-7807 problem document into an error a
 * screen can render without unwrapping anything.
 */

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1';

export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  support_reference?: string;
  correlation_id?: string;
  errors?: { path: string; message: string }[];
}

/**
 * An error carrying the server's own words.
 *
 * `detail` is written for the person reading the screen — "You cannot verify a
 * quantity you reported yourself (SoD-02)" — so screens render it directly
 * rather than substituting a generic message and throwing the useful one away.
 */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }
  get status() { return this.problem.status; }
  get supportReference() { return this.problem.support_reference; }
  /** Field-level messages, keyed by path, for inline form errors. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.path] = e.message;
    return out;
  }
}

/* ── Token storage ────────────────────────────────────────────────
   sessionStorage, not localStorage: a shared site tablet should not keep a
   supervisor signed in for the next person who picks it up. The refresh token
   is the only thing that survives a reload, and only for this tab. */
const ACCESS = 'ct.access';
const REFRESH = 'ct.refresh';
const DEVICE = 'ct.device';

export const tokens = {
  access: () => sessionStorage.getItem(ACCESS),
  refresh: () => sessionStorage.getItem(REFRESH),
  set(access: string, refresh: string) {
    sessionStorage.setItem(ACCESS, access);
    sessionStorage.setItem(REFRESH, refresh);
  },
  clear() {
    sessionStorage.removeItem(ACCESS);
    sessionStorage.removeItem(REFRESH);
  },
  /** Stable per browser: the sync engine dedupes deliveries per device. */
  deviceId(): string {
    let id = localStorage.getItem(DEVICE);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE, id);
    }
    return id;
  },
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  // Ten screens can 401 at the same moment. Sharing one in-flight refresh stops
  // ten refresh calls, nine of which would fail on a rotated refresh token and
  // log a working session out.
  if (refreshing) return refreshing;
  const rt = tokens.refresh();
  if (!rt) return false;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) { tokens.clear(); return false; }
      const body = await res.json() as { access_token: string; refresh_token: string };
      tokens.set(body.access_token, body.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: { retryOn401?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-device-id': tokens.deviceId() };
  const at = tokens.access();
  if (at) headers.authorization = `Bearer ${at}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (cause) {
    // A dead network is not a server error, and must not be reported as one.
    // The offline surface reads status 0 and shows a badge, not a dialog.
    throw new ApiError({
      title: 'No connection',
      status: 0,
      detail: 'You appear to be offline. Your work is saved on this device.',
    });
  }

  if (res.status === 401 && opts.retryOn401 !== false && tokens.refresh()) {
    if (await refreshOnce()) return request<T>(method, path, body, { ...opts, retryOn401: false });
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<Problem>;
    throw new ApiError({
      title: p.title ?? res.statusText ?? 'Request failed',
      status: p.status ?? res.status,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
      ...(p.support_reference !== undefined ? { support_reference: p.support_reference } : {}),
      ...(p.errors !== undefined ? { errors: p.errors } : {}),
    });
  }
  return parsed as T;
}

export const api = {
  get:   <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal ? { signal } : {}),
  post:  <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del:   <T>(path: string) => request<T>('DELETE', path),
};

/** Build a query string, dropping empties so the URL reflects real filters. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
