import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-A02 — Platform audit.
 *
 * Append-only, filterable, exportable. This is the log that answers "who
 * suspended that tenant, and what reason did they give" — the only place a
 * platform decision is ever explained, which is why the reason is shown in
 * full rather than truncated into a column.
 *
 * Filtering happens client-side over the returned page, deliberately: the
 * endpoint takes only a limit, and pretending otherwise with a filter box that
 * silently searched one page would be worse than saying so.
 */
interface Entry {
  id: string; occurred_at: string; action: string;
  actor_email?: string | null; actor_id?: string | null;
  entity_type: string; entity_id: string | null;
  org_id?: string | null; org_name?: string | null;
  reason?: string | null;
  context?: Record<string, unknown> | null;
  ip?: string | null;
}

export function PlatformAudit() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [limit, setLimit] = useState(100);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<{ data: Entry[] } | Entry[]>(`/platform/audit?limit=${limit}`);
      setRows(Array.isArray(r) ? r : r.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [limit]);

  const actions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.action))).sort(), [rows]);

  const shown = rows.filter((r) => {
    if (action && r.action !== action) return false;
    if (!q) return true;
    const hay = `${r.actor_email ?? ''} ${r.entity_type} ${r.org_name ?? ''} ${r.reason ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const exportCsv = () => {
    const head = ['when', 'actor', 'action', 'entity', 'organization', 'reason', 'ip'];
    const body = shown.map((r) => [
      r.occurred_at, r.actor_email ?? r.actor_id ?? '', r.action,
      `${r.entity_type}${r.entity_id ? ` ${r.entity_id}` : ''}`,
      r.org_name ?? r.org_id ?? '', r.reason ?? '', r.ip ?? '',
    ]);
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [head, ...body].map((r) => r.map((c) => esc(String(c))).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `platform-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Platform audit</h1>
          <p className="small muted">Append-only. Nothing here can be edited or removed.</p>
        </div>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={shown.length === 0}>
            <Download size={14} aria-hidden /> CSV
          </button>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 'var(--s2)' }}>
        <input className="input" style={{ width: '16rem' }} placeholder="Search actor, tenant or reason"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={action}
                onChange={(e) => setAction(e.target.value)}>
          <option value="">Any action</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}>
          {[100, 250, 500].map((n) => <option key={n} value={n}>Last {n}</option>)}
        </select>
        <span className="small muted" style={{ alignSelf: 'center' }}>
          {shown.length} of {rows.length} shown · filtering applies to the loaded page
        </span>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}
      {loading ? <Loading /> : shown.length === 0 ? (
        <EmptyState message="No platform actions recorded." />
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr>
              <th style={{ width: '11rem' }}>When</th><th>Actor</th><th>Action</th>
              <th>Entity</th><th>Organization</th><th>Reason</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="xs num muted">{new Date(r.occurred_at).toLocaleString()}</td>
                  <td className="small">{r.actor_email ?? r.actor_id?.slice(0, 8) ?? 'system'}</td>
                  <td><code className="xs">{r.action}</code></td>
                  <td className="small">{r.entity_type}</td>
                  <td className="small">{r.org_name ?? r.org_id?.slice(0, 8) ?? '—'}</td>
                  {/* Not truncated: the reason is the only explanation that
                      will ever exist for a decision taken here. */}
                  <td className="small">{r.reason ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
