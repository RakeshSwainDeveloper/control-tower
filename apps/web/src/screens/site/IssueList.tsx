import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip, SeverityChip } from '../../components/StatusChip.js';
import { EmptyState, Loading } from '../../components/Feedback.js';

/**
 * S-M12 — Issue list, on a phone.
 *
 * Filters as chips in the URL, so a project manager can send "the overdue
 * criticals" to a site engineer as a link and it opens the same view.
 *
 * The default is deliberately NOT "everything": it is what is still open. A
 * list that opens on 400 closed issues buries the eleven that are not.
 */
interface Issue {
  id: string; issue_number: string | null; title: string; severity: string;
  state_class: string; due_date: string | null; category: string | null;
  location: string | null; assignee: string | null; reopen_count: number;
}

export function IssueList() {
  const { projectId, can } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);

  const severity = params.get('severity') ?? '';
  const overdue = params.get('overdue') === 'true';
  const mine = params.get('mine') === 'true';
  const showClosed = params.get('closed') === 'true';

  const { me } = useSession();

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    void api.get<{ data: Issue[] }>(
      `/projects/${projectId}/issues${qs({
        limit: 100,
        severity: severity || undefined,
        overdue: overdue || undefined,
        assigneeUserId: mine ? me?.user_id : undefined,
      })}`)
      .then((r) => setRows(r.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [projectId, severity, overdue, mine, me?.user_id]);

  const toggle = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (next.get(key) === value) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  const visible = showClosed
    ? rows
    : rows.filter((r) => r.state_class !== 'closed' && r.state_class !== 'cancelled');
  const closedCount = rows.length - rows.filter(
    (r) => r.state_class !== 'closed' && r.state_class !== 'cancelled').length;

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      <div className="row-between">
        <h1>Issues</h1>
        {can('issue.issue.create') ? (
          <Link to="/site/issues/new" className="btn btn-primary btn-sm">
            <Plus size={16} aria-hidden /> Raise
          </Link>
        ) : null}
      </div>

      <div className="row wrap" style={{ gap: 'var(--s2)' }}>
        {['critical', 'high', 'medium', 'low'].map((s) => (
          <button key={s} type="button" className="chip-select btn-sm"
                  aria-pressed={severity === s} onClick={() => toggle('severity', s)}
                  style={severity === s
                    ? { background: `var(--sev-${s})`, borderColor: `var(--sev-${s})`, color: '#fff' }
                    : undefined}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
        <button type="button" className="chip-select btn-sm" aria-pressed={overdue}
                onClick={() => toggle('overdue', 'true')}>Overdue</button>
        <button type="button" className="chip-select btn-sm" aria-pressed={mine}
                onClick={() => toggle('mine', 'true')}>Mine</button>
      </div>

      {loading ? <Loading /> : visible.length === 0 ? (
        <EmptyState message={
          severity || overdue || mine
            ? 'Nothing matches those filters.'
            : 'No open issues. That is worth knowing.'} />
      ) : (
        <ul className="stack-2">
          {visible.map((i) => (
            <li key={i.id}>
              <Link to={`/site/issues/${i.id}`} className="list-row"
                    style={{ textDecoration: 'none', color: 'inherit', alignItems: 'flex-start',
                             paddingTop: 'var(--s3)', paddingBottom: 'var(--s3)' }}>
                <span className="grow stack-2" style={{ gap: 4, minWidth: 0 }}>
                  <strong className="truncate">{i.title}</strong>
                  <span className="row wrap" style={{ gap: 'var(--s2)' }}>
                    <SeverityChip severity={i.severity} />
                    <StatusChip state={i.state_class} />
                    {i.reopen_count > 0 ? (
                      <span className="chip" style={{ background: 'var(--st-rejected-bg)',
                                                      color: 'var(--st-rejected)' }}>
                        ↻{i.reopen_count}
                      </span>
                    ) : null}
                  </span>
                  <span className="xs muted truncate">
                    {i.location ?? 'No location'}
                    {i.assignee ? ` · ${i.assignee}` : ' · unassigned'}
                  </span>
                </span>
                {i.due_date ? (
                  <span className="xs num" style={{ flex: 'none', textAlign: 'right',
                    color: new Date(i.due_date) < new Date() ? 'var(--destructive)' : 'var(--muted-fg)',
                    fontWeight: new Date(i.due_date) < new Date() ? 600 : 400 }}>
                    {new Date(i.due_date).toLocaleDateString(undefined,
                      { day: 'numeric', month: 'short' })}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {closedCount > 0 ? (
        <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => toggle('closed', 'true')}>
          {showClosed ? 'Hide' : 'Show'} {closedCount} closed
        </button>
      ) : null}
    </div>
  );
}
