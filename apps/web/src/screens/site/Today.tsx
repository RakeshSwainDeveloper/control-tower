import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardList, Inbox, Plus, TriangleAlert,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { useSyncStatus } from '../../components/SyncBadge.js';
import { Loading } from '../../components/Feedback.js';

/**
 * S-M02 — Today. The site home screen.
 *
 * It answers three questions in the order a supervisor asks them at 7:40am:
 * what have I recorded today, what is waiting for me, and what can I do next.
 *
 * The tiles are permission-driven. A supervisor sees two; a site engineer who
 * also verifies sees three. Nobody sees a tile that will refuse them.
 */
interface WorkRow { kind: string; id: string; title: string; due_date: string | null; overdue: boolean }

export function Today() {
  const { can, projectId, me } = useSession();
  const sync = useSyncStatus();
  const [work, setWork] = useState<WorkRow[]>([]);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [report, setReport] = useState<{ state_class?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    const today = new Date().toISOString().slice(0, 10);
    void Promise.all([
      api.get<{ data: WorkRow[] }>(`/me/work?projectId=${projectId}&limit=20`)
        .then((r) => (Array.isArray(r) ? r : r.data ?? []))
        .catch(() => [] as WorkRow[]),
      api.get<{ data: unknown[] }>(`/projects/${projectId}/progress?limit=100&executedOn=${today}`)
        .then((r) => r.data?.length ?? 0).catch(() => 0),
      api.get<{ data: { state_class: string }[] }>(`/projects/${projectId}/daily-report?date=${today}`)
        .then((r) => r.data?.[0] ?? null).catch(() => null),
    ]).then(([w, c, r]) => {
      setWork(w); setTodayCount(c); setReport(r);
    }).finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <Loading label="Getting your day" />;

  const overdue = work.filter((w) => w.overdue).length;

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      {/* What the supervisor is called here — the same words the audit trail
          will use for anything they record today (FR-030). */}
      <p className="small muted">
        {Array.from(new Set(me?.permissions.map((p) => p.responsibility)))
          .slice(0, 2).join(' · ') || 'No responsibilities granted yet'}
      </p>

      {sync.attention > 0 ? (
        <Link to="/site/sync" className="banner banner-bad" style={{ textDecoration: 'none' }}>
          <TriangleAlert size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <div className="stack-2">
            <strong>{sync.attention} item{sync.attention === 1 ? '' : 's'} need your attention</strong>
            <span className="small">The office has not accepted them. Tap to see why.</span>
          </div>
        </Link>
      ) : null}

      <section className="stack-2">
        <h2 className="label">Today</h2>
        <div className="row" style={{ gap: 'var(--s3)' }}>
          <Stat value={todayCount ?? 0} label="entries recorded" />
          <Stat value={sync.pending} label="waiting to send"
                warn={sync.pending > 0} />
          <Stat value={overdue} label="overdue" warn={overdue > 0} />
        </div>
      </section>

      <section className="stack-2">
        <h2 className="label">Record</h2>
        <div className="stack-2">
          {can('field.progress.create') ? (
            <Tile to="/site/progress" icon={Plus} title="Progress"
                  sub="Quantity done, with photographs" primary />
          ) : null}
          {can('issue.issue.create') ? (
            <Tile to="/site/issues/new" icon={TriangleAlert} title="Raise an issue"
                  sub="Something is wrong on site" />
          ) : null}
          {can('field.daily_report.create') ? (
            <Tile to="/site/report" icon={ClipboardList} title="Daily report"
                  sub={report?.state_class === 'submitted'
                    ? 'Submitted for today'
                    : `Review and submit${todayCount ? ` · ${todayCount} entries` : ''}`} />
          ) : null}
        </div>
      </section>

      <section className="stack-2">
        <div className="row-between">
          <h2 className="label">Waiting for you</h2>
          <Link to="/site/work" className="small">See all</Link>
        </div>
        {work.length === 0 ? (
          <p className="small muted">Nothing is waiting for you.</p>
        ) : (
          <ul className="stack-2">
            {work.slice(0, 4).map((w) => (
              <li key={`${w.kind}-${w.id}`}>
                <Link to="/site/work" className="list-row" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <Inbox size={18} aria-hidden className="muted" />
                  <span className="grow stack-2" style={{ gap: 0, minWidth: 0 }}>
                    <strong className="truncate">{w.title}</strong>
                    <span className="xs muted">{w.kind.replace('_', ' ')}</span>
                  </span>
                  {w.overdue ? <span className="chip" style={{
                    background: 'var(--st-rejected-bg)', color: 'var(--st-rejected)' }}>Late</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  return (
    <div className="card card-p grow stack-2" style={{ padding: 'var(--s3) var(--s4)', gap: 0 }}>
      <strong className="num" style={{ fontSize: 'var(--text-2xl)',
        color: warn && value > 0 ? 'var(--st-progress)' : undefined }}>{value}</strong>
      <span className="xs muted">{label}</span>
    </div>
  );
}

function Tile({ to, icon: Icon, title, sub, primary }: {
  to: string; icon: typeof Plus; title: string; sub: string; primary?: boolean;
}) {
  return (
    <Link to={to} className="list-row" style={{
      textDecoration: 'none', color: primary ? 'var(--primary-fg)' : 'inherit',
      background: primary ? 'var(--primary)' : undefined,
      borderColor: primary ? 'var(--primary)' : undefined,
      minHeight: primary ? '4rem' : undefined,
    }}>
      <Icon size={primary ? 24 : 20} aria-hidden />
      <span className="grow stack-2" style={{ gap: 0 }}>
        <strong>{title}</strong>
        <span className="xs" style={{ opacity: 0.75 }}>{sub}</span>
      </span>
    </Link>
  );
}
