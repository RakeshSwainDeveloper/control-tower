import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ScrollText } from 'lucide-react';
import { api, ApiError, qs, tokens, API_BASE } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W11 — Audit and record timeline.
 *
 * Two views of the same append-only log, because there are two questions.
 * "Show me everything that happened" is a filtered list; "what happened to
 * THIS record" is a timeline in sentences. The second settles arguments, so
 * the server renders it — every client should say it the same way.
 *
 * The CSV honours the active filters, so what somebody exports is what they
 * were looking at.
 */
interface Row {
  id: string; occurred_at: string; entity_type: string; entity_id: string;
  action: string; actor_name: string | null; responsibility_label: string | null;
  source: string; project_code: string | null;
  changes: { field: string; old: unknown; new: unknown }[] | null;
  correlation_id: string | null;
}
interface TimelineEntry {
  id: string; at: string; actor: string | null; responsibility: string | null;
  action: string; source: string; sentence: string;
}

const ENTITIES = ['progress_entry', 'daily_report', 'issue', 'action', 'project',
                  'work_item', 'user', 'approval_definition', 'evidence'];
const ACTIONS = ['create', 'update', 'transition', 'approve', 'reject', 'verify',
                 'comment', 'import', 'export', 'config_change', 'login'];

export function Audit() {
  const { projectId } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [timeline, setTimeline] = useState<{ what: string; data: TimelineEntry[] } | null>(null);

  const entityType = params.get('entityType') ?? '';
  const action = params.get('action') ?? '';
  const scoped = params.get('project') !== 'all';

  const load = async (after: string | null, append: boolean) => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<{ data: Row[]; next_cursor: string | null; has_more: boolean }>(
        `/audit${qs({
          projectId: scoped ? projectId ?? undefined : undefined,
          entityType: entityType || undefined,
          action: action || undefined,
          cursor: after ?? undefined,
          limit: 100,
        })}`);
      setRows((p) => (append ? [...p, ...r.data] : r.data));
      setCursor(r.next_cursor); setHasMore(r.has_more);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(null, false); /* eslint-disable-next-line */ },
    [projectId, entityType, action, scoped]);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const openTimeline = async (r: Row) => {
    setTimeline({ what: `${r.entity_type} ${r.entity_id.slice(0, 8)}`, data: [] });
    const t = await api.get<{ data: TimelineEntry[] }>(
      `/audit/${r.entity_type}/${r.entity_id}`).catch(() => ({ data: [] }));
    setTimeline({ what: `${r.entity_type} ${r.entity_id.slice(0, 8)}`, data: t.data });
  };

  /**
   * The export is a normal authenticated GET, not a link.
   *
   * An <a download> would drop the Authorization header and get a 401, so the
   * bytes are fetched and handed to the browser as a blob.
   */
  const exportCsv = async () => {
    const url = `${API_BASE}/audit.csv${qs({
      projectId: scoped ? projectId ?? undefined : undefined,
      entityType: entityType || undefined,
      action: action || undefined,
      limit: 5000,
    })}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${tokens.access()}` } });
    if (!res.ok) { setError(new ApiError({ title: 'Export failed', status: res.status })); return; }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Audit</h1>
          <p className="small muted">
            Append-only. Nothing here can be edited or removed, by anyone.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void exportCsv()}
                disabled={rows.length === 0}>
          <Download size={14} aria-hidden /> CSV
        </button>
      </div>

      <div className="row wrap" style={{ gap: 'var(--s2)' }}>
        <select className="select" style={{ width: 'auto' }} value={entityType}
                onChange={(e) => setFilter('entityType', e.target.value)}
                aria-label="Record type">
          <option value="">Any record type</option>
          {ENTITIES.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={action}
                onChange={(e) => setFilter('action', e.target.value)} aria-label="Action">
          <option value="">Any action</option>
          {ACTIONS.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}
        </select>
        <button type="button" className="btn btn-sm" aria-pressed={!scoped}
                onClick={() => setFilter('project', scoped ? 'all' : '')}>
          {scoped ? 'This project' : 'All projects'}
        </button>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load(null, false)} /> : null}

      {timeline ? (
        <section className="card card-p stack-2">
          <div className="row-between">
            <h2 className="label row" style={{ gap: 'var(--s2)' }}>
              <ScrollText size={14} aria-hidden /> {timeline.what}
            </h2>
            <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => setTimeline(null)}>Close</button>
          </div>
          {timeline.data.length === 0 ? <Loading /> : (
            <ol className="stack-2">
              {timeline.data.map((e) => (
                <li key={e.id} className="row" style={{ gap: 'var(--s3)', alignItems: 'baseline' }}>
                  <span className="xs muted num" style={{ flex: 'none', width: '11rem' }}>
                    {new Date(e.at).toLocaleString()}
                  </span>
                  {/* The server renders the sentence so every client says it
                      the same way. */}
                  <span className="small">{e.sentence}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {rows.length === 0 && !loading ? (
        <EmptyState message="Nothing recorded for those filters." />
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr>
              <th style={{ width: '11rem' }}>When</th>
              <th>Who</th><th>Did what</th><th>To</th><th>Changes</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => void openTimeline(r)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') void openTimeline(r); }}>
                  <td className="xs num muted">{new Date(r.occurred_at).toLocaleString()}</td>
                  <td className="small">
                    {r.actor_name ?? 'system'}
                    {/* FR-030: in what capacity, not merely who. */}
                    {r.responsibility_label ? (
                      <span className="xs muted" style={{ display: 'block' }}>
                        as {r.responsibility_label}
                      </span>
                    ) : null}
                  </td>
                  <td><code className="xs">{r.action}</code></td>
                  <td className="small">
                    {r.entity_type.replace(/_/g, ' ')}
                    {r.project_code ? <span className="xs muted"> · {r.project_code}</span> : null}
                  </td>
                  <td className="small muted">
                    {Array.isArray(r.changes) && r.changes.length > 0
                      ? r.changes.slice(0, 2).map((c) => c.field.replace(/_/g, ' ')).join(', ')
                        + (r.changes.length > 2 ? ` +${r.changes.length - 2}` : '')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading ? <Loading /> : null}
      {hasMore ? (
        <button type="button" className="btn" onClick={() => void load(cursor, true)}>
          Load more
        </button>
      ) : rows.length > 0 ? (
        <p className="small muted">{rows.length} entries</p>
      ) : null}
    </div>
  );
}
