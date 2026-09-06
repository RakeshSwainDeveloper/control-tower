import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W02 — Portfolio. The dashboard's top band, one row per project.
 *
 * Computed by the server in a single pass. A management view over twenty
 * sites should be one query, not twenty dashboard calls, and deriving the
 * percentages client-side would let this screen disagree with S-W03 about the
 * same project.
 *
 * Red flags are rendered as a column of their own rather than as row colour,
 * because colour alone is never the sole carrier of meaning (UI_UX_PLAN §6).
 */
interface Row {
  id: string; code: string; name: string; state_class: string;
  verified_pct: number; reported_pct: number; gap_pct: number;
  awaiting_verification: number;
  open_issues: number; overdue_issues: number;
  open_approvals: number; oldest_approval_hours: number;
  last_report_date: string | null; missing_report_days: number;
}
interface Portfolio {
  metric: string; as_of: string; definition: string; data: Row[];
}

export function Portfolio() {
  const { setProjectId } = useSession();
  const nav = useNavigate();
  const [p, setP] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void api.get<Portfolio>('/portfolio')
      .then(setP)
      .catch((e) => setError(e instanceof ApiError ? e : null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading label="Loading the portfolio" />;
  if (error) return <ErrorBanner error={error} />;
  if (!p || p.data.length === 0) return <EmptyState message="No active projects." />;

  const open = (r: Row) => { setProjectId(r.id); nav('/office'); };

  const flags = (r: Row): string[] => {
    const out: string[] = [];
    if (r.missing_report_days >= 2) out.push(`${r.missing_report_days} days with no report`);
    if (r.overdue_issues > 0) out.push(`${r.overdue_issues} overdue`);
    if (r.gap_pct >= 25 && r.reported_pct > 0) out.push(`${Math.round(r.gap_pct)}% unverified`);
    if (r.oldest_approval_hours >= 48) {
      out.push(`approval waiting ${Math.round(r.oldest_approval_hours / 24)}d`);
    }
    return out;
  };

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="stack-2">
        <h1>Portfolio</h1>
        <p className="small muted">
          {p.data.length} active project{p.data.length === 1 ? '' : 's'} ·
          as of {new Date(p.as_of).toLocaleString()}
        </p>
      </div>

      <div className="card scroll-x">
        <table className="table">
          <thead><tr>
            <th>Project</th>
            <th className="n">Verified</th>
            <th className="n">Gap</th>
            <th className="n">Awaiting</th>
            <th className="n">Issues</th>
            <th className="n">Approvals</th>
            <th>Flags</th>
          </tr></thead>
          <tbody>
            {p.data.map((r) => {
              const f = flags(r);
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => open(r)}
                    tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(r); }}>
                  <td>
                    <span className="stack-2" style={{ gap: 0 }}>
                      <strong className="small">{r.name}</strong>
                      <span className="xs muted">{r.code}</span>
                    </span>
                  </td>
                  <td className="n">
                    <span className="num" style={{ fontWeight: 600 }}>{r.verified_pct}%</span>
                    <span className="xs muted" style={{ display: 'block' }}>
                      reported {r.reported_pct}%
                    </span>
                  </td>
                  <td className="n num" style={{
                    color: r.gap_pct >= 25 ? 'var(--st-progress)' : undefined,
                    fontWeight: r.gap_pct >= 25 ? 600 : 400 }}>
                    {r.gap_pct}%
                  </td>
                  <td className="n num">{r.awaiting_verification}</td>
                  <td className="n num">
                    {r.open_issues}
                    {r.overdue_issues > 0 ? (
                      <span className="xs" style={{ display: 'block', color: 'var(--destructive)' }}>
                        {r.overdue_issues} overdue
                      </span>
                    ) : null}
                  </td>
                  <td className="n num">
                    {r.open_approvals}
                    {r.oldest_approval_hours > 0 ? (
                      <span className="xs muted" style={{ display: 'block' }}>
                        oldest {Math.round(r.oldest_approval_hours)}h
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {f.length === 0 ? <span className="muted small">—</span> : (
                      <span className="stack-2" style={{ gap: 2 }}>
                        {f.map((x) => (
                          <span key={x} className="row xs" style={{
                            gap: 'var(--s1)', color: 'var(--destructive)' }}>
                            <AlertTriangle size={11} aria-hidden /> {x}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="xs muted">{p.definition}</p>
    </div>
  );
}
