import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Inbox } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useProject, useSession } from '../../lib/session.js';
import { MetricValue } from '../../components/DrillLink.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W03 — Project dashboard, in three bands (FR-525):
 * what I need to know · what needs my action · what is going wrong.
 *
 * `UI_UX_PLAN.md` §5.1 sketches this with budget, schedule, stock and
 * advances. None exist in the MVP — `MVP_SCOPE.md` §112 removes the schedule
 * tile outright ("nothing to compute it from") and the no-money boundary
 * removes the rest. Tiles invented from data the product does not hold would
 * make this a mock-up, so only measured numbers appear.
 *
 * Every tile carries its definition and drills through (FR-522). The third
 * band shows only what is actually wrong: an empty "going wrong" band is the
 * most useful thing this screen can say, and padding it with green tiles
 * would destroy that.
 */
interface Metric {
  key: string; value: number; unit: string; secondary?: string;
  definition: string; as_of: string;
  drill?: { endpoint?: string; params?: Record<string, unknown> };
}
interface Dash {
  as_of: string;
  know: Metric[];
  act: {
    approvals_i_owe: number; issues_assigned_to_me: number;
    entries_awaiting_verification: number;
    definition: string; as_of: string;
  };
  wrong: { key: string; severity: 'warn' | 'bad'; message: string;
           drill?: { to: string } }[];
  reports: { submitted_last_14_days: number; missing_days: number;
             last_report_date: string | null };
}

const DRILL: Record<string, string> = {
  verified_progress: '/office/progress',
  verification_gap: '/office/progress?status=reported',
  open_approvals: '/office/approvals',
  open_issues: '/office/issues',
};

export function Dashboard() {
  const { projectId } = useSession();
  const project = useProject();
  const [dash, setDash] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    void api.get<Dash>(`/projects/${projectId}/dashboard`)
      .then(setDash)
      .catch((e) => setError(e instanceof ApiError ? e : null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (!projectId) return <EmptyState message="Select a project to see its dashboard." />;
  if (loading) return <Loading label="Building the dashboard" />;
  if (error) return <ErrorBanner error={error} />;
  /**
   * Defend against a payload that is not the shape we expect.
   *
   * `dash.know.map(...)` throws on an older or partial response and takes the
   * whole page down. A dashboard that renders three empty bands after a
   * deploy skew is recoverable; a white page is a support call.
   */
  const know = Array.isArray(dash?.know) ? dash.know : [];
  const wrong = Array.isArray(dash?.wrong) ? dash.wrong : [];
  const actCounts = dash?.act ?? {
    approvals_i_owe: 0, issues_assigned_to_me: 0, entries_awaiting_verification: 0,
    definition: '', as_of: '',
  };
  const reports = dash?.reports;
  if (!dash || know.length === 0) {
    return <EmptyState message="No dashboard data for this project yet." />;
  }

  const act = actCounts.approvals_i_owe + actCounts.issues_assigned_to_me
    + actCounts.entries_awaiting_verification;

  return (
    <div className="stack" style={{ gap: 'var(--s8)' }}>
      <div className="stack-2">
        <h1>{project?.name ?? 'Project'}</h1>
        <p className="small muted">
          As of {new Date(dash.as_of).toLocaleString()}
        </p>
      </div>

      <section className="stack">
        <h2 className="label">What I need to know</h2>
        <div style={{ display: 'grid', gap: 'var(--s3)',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))' }}>
          {know.map((m) => (
            <MetricValue
              key={m.key}
              value={m.unit === 'percent' ? `${m.value}%` : m.value}
              label={m.secondary ?? LABEL[m.key] ?? m.key}
              metric={m}
              to={DRILL[m.key]}
            />
          ))}
        </div>
      </section>

      <section className="stack">
        <h2 className="label">What needs my action</h2>
        {act === 0 ? (
          <p className="row small muted" style={{ gap: 'var(--s2)' }}>
            <CheckCircle2 size={16} aria-hidden style={{ color: 'var(--st-verified)' }} />
            Nothing is waiting on you.
          </p>
        ) : (
          <div className="row wrap" style={{ gap: 'var(--s3)' }}>
            <Action to="/office/approvals" n={actCounts.approvals_i_owe}
                    label="approval decisions you owe" />
            <Action to="/office/progress?status=reported" n={actCounts.entries_awaiting_verification}
                    label="claims waiting for a verifier" />
            <Action to="/office/issues" n={actCounts.issues_assigned_to_me}
                    label="issues assigned to you" />
          </div>
        )}
        {actCounts.definition ? <p className="xs muted">{actCounts.definition}</p> : null}
      </section>

      <section className="stack">
        <h2 className="label">What is going wrong</h2>
        {wrong.length === 0 ? (
          /* The valuable empty state on this whole screen. */
          <div className="banner banner-ok">
            <CheckCircle2 size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
            <div className="stack-2">
              <strong>Nothing is flagged</strong>
              <span className="small">
                Reports are being submitted, claims are being verified, and
                nothing is past its date.
              </span>
            </div>
          </div>
        ) : (
          <ul className="stack-2">
            {wrong.map((w) => {
              const body = (
                <>
                  <AlertTriangle size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
                  <span className="grow">{w.message}</span>
                </>
              );
              return (
                <li key={w.key}>
                  {w.drill ? (
                    <Link to={w.drill.to}
                          className={w.severity === 'bad' ? 'banner banner-bad' : 'banner banner-warn'}
                          style={{ textDecoration: 'none' }}>
                      {body}
                    </Link>
                  ) : (
                    <div className={w.severity === 'bad' ? 'banner banner-bad' : 'banner banner-warn'}>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {reports ? (
        <section className="stack-2">
          <h2 className="label">Daily reports</h2>
          <p className="small">
            {reports.submitted_last_14_days} submitted in the last 14 days
            {reports.last_report_date
              ? ` · last one ${new Date(reports.last_report_date).toDateString()}`
              : ' · none yet'}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Action({ to, n, label }: { to: string; n: number; label: string }) {
  if (n === 0) return null;
  return (
    <Link to={to} className="card card-p row" style={{
      textDecoration: 'none', color: 'inherit', gap: 'var(--s3)', minWidth: '12rem',
    }}>
      <Inbox size={20} aria-hidden className="muted" />
      <span className="stack-2" style={{ gap: 0 }}>
        <strong className="num" style={{ fontSize: 'var(--text-xl)' }}>{n}</strong>
        <span className="xs muted">{label}</span>
      </span>
    </Link>
  );
}

const LABEL: Record<string, string> = {
  verified_progress: 'verified progress',
  verification_gap: 'reported but not verified',
  open_approvals: 'approvals open',
  open_issues: 'issues open',
};
