import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Search } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api.js';
import { EmptyState, ErrorBanner, Loading } from './Feedback.js';

/**
 * The standard list.
 *
 * Server-side filter and keyset pagination, filter state in the URL, CSV export
 * that honours the active filters. Built once because eleven office screens are
 * this component with different columns, and because a list that paginates by
 * OFFSET drifts the moment somebody inserts a row while you are reading page 3.
 *
 * Filter state lives in the URL, not in component state, so a project manager
 * can send "the overdue criticals on Tower B" to a site engineer as a link.
 */

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Right-align and tabular-align. Every quantity column sets this. */
  numeric?: boolean;
  width?: string;
}

export interface FilterDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'toggle';
  options?: { value: string; label: string }[];
}

interface Page<T> { data: T[]; next_cursor: string | null; has_more: boolean }

export function StandardList<T extends { id: string }>({
  endpoint, columns, filters = [], rowKey, onRowClick, emptyMessage, extraParams, csvName,
}: {
  endpoint: string;
  columns: Column<T>[];
  filters?: FilterDef[];
  rowKey?: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  extraParams?: Record<string, string | number | boolean | undefined>;
  csvName?: string;
}) {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Only the declared filters go to the server. Anything else in the URL is
  // somebody else's state and must not become a query parameter.
  const active = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of filters) {
      const v = params.get(f.key);
      if (v) out[f.key] = v;
    }
    return out;
  }, [params, filters]);

  const load = async (after: string | null, append: boolean) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    setError(null);
    try {
      const url = endpoint + qs({ ...extraParams, ...active, cursor: after ?? undefined, limit: 50 });
      const page = await api.get<Page<T>>(url, ac.signal);
      setRows((prev) => (append ? [...prev, ...page.data] : page.data));
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => { void load(null, false); /* eslint-disable-next-line */ },
    [endpoint, JSON.stringify(active), JSON.stringify(extraParams)]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  /** CSV of what is on screen, with the filters named in the file. */
  const exportCsv = () => {
    const head = columns.map((c) => c.header);
    const body = rows.map((r) => columns.map((c) => {
      const v = (r as Record<string, unknown>)[c.key];
      return v === null || v === undefined ? '' : String(v);
    }));
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [head, ...body].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    const suffix = Object.entries(active).map(([k, v]) => `${k}-${v}`).join('_');
    a.href = url;
    a.download = `${csvName ?? 'export'}${suffix ? `_${suffix}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      {filters.length > 0 || rows.length > 0 ? (
        <div className="row wrap" style={{ gap: 'var(--s2)' }}>
          {filters.map((f) => (
            <label key={f.key} className="row" style={{ gap: 'var(--s2)' }}>
              <span className="sr-only">{f.label}</span>
              {f.type === 'select' ? (
                <select
                  className="select" style={{ width: 'auto' }}
                  value={params.get(f.key) ?? ''}
                  onChange={(e) => setFilter(f.key, e.target.value)}
                >
                  <option value="">{f.label}: any</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === 'toggle' ? (
                <button
                  type="button" className="btn btn-sm"
                  aria-pressed={params.get(f.key) === 'true'}
                  style={params.get(f.key) === 'true'
                    ? { background: 'var(--primary)', color: 'var(--primary-fg)', borderColor: 'var(--primary)' }
                    : undefined}
                  onClick={() => setFilter(f.key, params.get(f.key) === 'true' ? '' : 'true')}
                >
                  {f.label}
                </button>
              ) : (
                <span className="row" style={{ gap: 'var(--s1)' }}>
                  <Search size={15} className="muted" aria-hidden />
                  <input
                    className="input" style={{ width: '12rem' }} placeholder={f.label}
                    defaultValue={params.get(f.key) ?? ''}
                    onBlur={(e) => setFilter(f.key, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setFilter(f.key, e.currentTarget.value); }}
                  />
                </span>
              )}
            </label>
          ))}
          <span className="grow" />
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download size={15} aria-hidden /> CSV
          </button>
        </div>
      ) : null}

      {error ? <ErrorBanner error={error} onRetry={() => void load(null, false)} /> : null}

      {rows.length === 0 && !loading && !error ? (
        <EmptyState message={emptyMessage ?? 'Nothing here yet.'} />
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead>
              <tr>{columns.map((c) => (
                <th key={c.key} style={{ width: c.width, textAlign: c.numeric ? 'right' : 'left' }}>
                  {c.header}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={rowKey?.(r) ?? r.id}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick
                    ? (e) => { if (e.key === 'Enter') onRowClick(r); }
                    : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? 'n' : undefined}>{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading ? <Loading /> : null}

      {hasMore ? (
        <button type="button" className="btn" onClick={() => void load(cursor, true)} disabled={loading}>
          Load more
        </button>
      ) : rows.length > 0 ? (
        <p className="small muted">{rows.length} row{rows.length === 1 ? '' : 's'}</p>
      ) : null}
    </div>
  );
}
