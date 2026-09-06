import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StandardList, type Column } from '../../components/StandardList.js';
import { StatusChip, SeverityChip } from '../../components/StatusChip.js';
import { MetricValue } from '../../components/DrillLink.js';
import { EmptyState, Loading } from '../../components/Feedback.js';

/**
 * S-W07 — Issue register.
 *
 * Server-side filtered list plus ageing. The ageing panel is the reason this
 * screen is not just S-M12 on a bigger display: a project manager does not
 * need to read every open issue, they need to know that the criticals have
 * been open a median of eleven days.
 *
 * Ageing is what makes a neglected issue visible. A list sorted by date shows
 * the newest; nobody scrolls to the bottom.
 */
interface Issue {
  id: string; issue_number: string | null; title: string; severity: string;
  state_class: string; due_date: string | null; category: string | null;
  location: string | null; assignee: string | null; raised_at: string;
  reopen_count: number;
}

interface Ageing {
  metric: string; as_of: string; definition: string;
  by_severity: { severity: string; open: number; overdue: number;
                 median_age_days: number; max_age_days: number }[];
  drill?: { endpoint?: string; params?: Record<string, unknown> };
}

export function IssueRegister() {
  const { projectId } = useSession();
  const nav = useNavigate();
  const [ageing, setAgeing] = useState<Ageing | null>(null);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    void Promise.all([
      api.get<Ageing>(`/projects/${projectId}/issues/ageing`).catch(() => null),
      api.get<{ data: { code: string; name: string }[] }>('/master-data?kind=issue_category')
        .then((r) => r.data ?? []).catch(() => []),
    ]).then(([a, c]) => { setAgeing(a); setCategories(c); })
      .finally(() => setLoading(false));
  }, [projectId]);

  if (!projectId) return <EmptyState message="Select a project first." />;
  if (loading) return <Loading label="Loading the register" />;

  const columns: Column<Issue>[] = [
    { key: 'issue_number', header: 'No.',
      render: (r) => <code className="xs">{r.issue_number ?? '—'}</code>, width: '9rem' },
    { key: 'title', header: 'Issue', render: (r) => (
        <span className="stack-2" style={{ gap: 0 }}>
          <strong className="small">{r.title}</strong>
          <span className="xs muted">{r.location ?? 'No location'}</span>
        </span>
      ) },
    { key: 'severity', header: 'Severity',
      render: (r) => <SeverityChip severity={r.severity} />, width: '7rem' },
    { key: 'state_class', header: 'Status',
      render: (r) => (
        <span className="row" style={{ gap: 'var(--s1)' }}>
          <StatusChip state={r.state_class} />
          {r.reopen_count > 0 ? (
            <span className="chip" style={{ background: 'var(--st-rejected-bg)',
                                            color: 'var(--st-rejected)' }}>↻{r.reopen_count}</span>
          ) : null}
        </span>
      ), width: '9rem' },
    { key: 'category', header: 'Category',
      render: (r) => <span className="small muted">{r.category ?? '—'}</span>, width: '8rem' },
    { key: 'assignee', header: 'Assigned to',
      render: (r) => <span className="small">{r.assignee ?? <span className="muted">nobody</span>}</span> },
    { key: 'age', header: 'Open for', numeric: true, width: '7rem',
      render: (r) => {
        const days = Math.floor((Date.now() - new Date(r.raised_at).getTime()) / 86_400_000);
        const stale = days > 14 && r.state_class !== 'closed';
        return <span className="num" style={{ color: stale ? 'var(--destructive)' : undefined,
                                              fontWeight: stale ? 600 : 400 }}>{days}d</span>;
      } },
    { key: 'due_date', header: 'Due', numeric: true, width: '7rem',
      render: (r) => r.due_date
        ? <span className="num" style={{
            color: new Date(r.due_date) < new Date() && r.state_class !== 'closed'
              ? 'var(--destructive)' : undefined }}>
            {new Date(r.due_date).toLocaleDateString()}
          </span>
        : <span className="muted">—</span> },
  ];

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="stack-2">
        <h1>Issue register</h1>
        <p className="small muted">Everything raised on this project, and how long it has sat.</p>
      </div>

      {ageing && ageing.by_severity.length > 0 ? (
        <section className="stack-2">
          <h2 className="label">Ageing</h2>
          <div style={{ display: 'grid', gap: 'var(--s3)',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }}>
            {ageing.by_severity.map((s) => (
              <MetricValue key={s.severity}
                value={s.open} unit={s.overdue > 0 ? `· ${s.overdue} overdue` : undefined}
                label={`${s.severity} open · median ${s.median_age_days}d, oldest ${s.max_age_days}d`}
                to={`/office/issues?severity=${s.severity}`} />
            ))}
          </div>
          {/* FR-522: what it counts and when it was computed. */}
          <p className="xs muted">{ageing.definition} · as of {new Date(ageing.as_of).toLocaleString()}</p>
        </section>
      ) : null}

      <StandardList<Issue>
        endpoint={`/projects/${projectId}/issues`}
        csvName="issues"
        columns={columns}
        filters={[
          { key: 'severity', label: 'Severity', type: 'select',
            options: ['critical', 'high', 'medium', 'low'].map((v) => ({
              value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
          { key: 'state', label: 'Status', type: 'select',
            options: ['draft', 'in_progress', 'resolved', 'verified', 'closed'].map((v) => ({
              value: v, label: v.replace('_', ' ') })) },
          { key: 'overdue', label: 'Overdue only', type: 'toggle' },
        ]}
        onRowClick={(r) => nav(`/office/issues/${r.id}`)}
        emptyMessage="No issues have been raised on this project."
      />
      {categories.length === 0 ? null : (
        <p className="xs muted">
          Categories in use: {categories.map((c) => c.name).join(' · ')}
        </p>
      )}
    </div>
  );
}
