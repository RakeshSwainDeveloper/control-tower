import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, FileWarning } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip } from '../../components/StatusChip.js';
import { RecordPage, Details, Timeline, type TimelineEvent } from '../../components/RecordPage.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W05 — Daily reports: the list, and one report in full.
 *
 * The list leads with **missing days**, not with the reports that exist. A
 * project manager already knows about the reports they received; the useful
 * information is the Tuesday nobody submitted, and a list sorted newest-first
 * hides exactly that.
 */
interface Entry {
  id: string; reported_qty: string; verified_qty: string | null;
  verification_status: string; unit: string; work_item: string; location: string;
  reported_by_name: string | null; reported_responsibility: string | null;
}
interface Report {
  id: string; report_date: string; state_class: string;
  weather: string | null; notes: string | null;
  submitted_at: string | null; submitted_by_name?: string | null;
  submitted_responsibility?: string | null;
  entry_count?: number;
}

export function DailyReports() {
  const { projectId } = useSession();
  const nav = useNavigate();
  const [missing, setMissing] = useState<string[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    void Promise.all([
      api.get<{ data?: string[]; missing?: string[] }>(
        `/projects/${projectId}/daily-report/missing?from=${from}&to=${to}`)
        .then((r) => r.missing ?? r.data ?? []).catch(() => [] as string[]),
      api.get<{ data: Report[] }>(`/projects/${projectId}/daily-report?limit=60`)
        .then((r) => r.data ?? []).catch(() => [] as Report[]),
    ]).then(([m, rs]) => { setMissing(m); setReports(rs); })
      .catch((e) => setError(e instanceof ApiError ? e : null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <Loading label="Loading daily reports" />;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="stack-2">
        <h1>Daily reports</h1>
        <p className="small muted">The last 30 days.</p>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      {/* The missing days come first. A report that was never submitted is the
          only thing on this screen somebody has to act on. */}
      {missing.length > 0 ? (
        <div className="banner banner-warn">
          <FileWarning size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <div className="stack-2 grow">
            <strong>
              {missing.length} day{missing.length === 1 ? '' : 's'} with no report
            </strong>
            <span className="row wrap small" style={{ gap: 'var(--s2)' }}>
              {missing.slice(0, 14).map((d) => (
                <span key={d} className="chip" style={{
                  background: 'var(--st-rejected-bg)', color: 'var(--st-rejected)' }}>
                  {new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                </span>
              ))}
              {missing.length > 14 ? <span className="muted">+{missing.length - 14} more</span> : null}
            </span>
          </div>
        </div>
      ) : null}

      {reports.length === 0 ? (
        <EmptyState message="No daily reports have been submitted for this project." />
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr>
              <th>Date</th><th>Status</th><th>Weather</th>
              <th className="n">Entries</th><th>Submitted by</th>
            </tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }}
                    onClick={() => nav(`/office/reports/${r.id}`)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') nav(`/office/reports/${r.id}`); }}>
                  <td>
                    <span className="row" style={{ gap: 'var(--s2)' }}>
                      <CalendarDays size={14} aria-hidden className="muted" />
                      {new Date(r.report_date).toDateString()}
                    </span>
                  </td>
                  <td><StatusChip state={r.state_class} /></td>
                  <td className="small muted">{r.weather ?? '—'}</td>
                  <td className="n num">{r.entry_count ?? '—'}</td>
                  <td className="small">
                    {r.submitted_by_name ?? '—'}
                    {r.submitted_responsibility ? (
                      <span className="xs muted"> as {r.submitted_responsibility}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DailyReportDetail() {
  const { reportId } = useParams();
  const { projectId } = useSession();
  const [report, setReport] = useState<Report | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [trail, setTrail] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!projectId || !reportId) return;
    void (async () => {
      try {
        const r = await api.get<{ report: Report; entries: Entry[] }>(
          `/projects/${projectId}/daily-report?reportId=${reportId}`);
        setReport(r.report);
        setEntries(r.entries ?? []);
        setAssets(await loadEvidence('daily_report', reportId).catch(() => []));
        const t = await api.get<{ instance: unknown; decisions: {
          decided_at: string; decision: string; comment: string | null;
          decided_by_name?: string | null; responsibility_label?: string | null;
        }[] }>(`/approvals/daily_report/${reportId}/trail`).catch(() => null);
        if (t?.decisions) {
          setTrail(t.decisions.map((d) => ({
            at: d.decided_at,
            action: d.decision === 'approve' ? 'Approved'
              : d.decision === 'reject' ? 'Rejected'
              : d.decision === 'query' ? 'Question raised' : 'Put on hold',
            actor: d.decided_by_name ?? null,
            responsibility: d.responsibility_label ?? null,
            detail: d.comment,
          })));
        }
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
      } finally { setLoading(false); }
    })();
  }, [projectId, reportId]);

  if (loading) return <Loading label="Loading the report" />;
  if (error) return <ErrorBanner error={error} />;
  if (!report) return <EmptyState message="That report could not be found." />;

  const reported = entries.reduce((n, e) => n + Number(e.reported_qty), 0);
  const verified = entries.reduce((n, e) => n + Number(e.verified_qty ?? 0), 0);

  return (
    <RecordPage
      back="/office/reports"
      title={new Date(report.report_date).toDateString()}
      subtitle={report.submitted_at
        ? `Submitted ${new Date(report.submitted_at).toLocaleString()} by ${report.submitted_by_name ?? 'unknown'}${
            report.submitted_responsibility ? ` as ${report.submitted_responsibility}` : ''}`
        : 'Not yet submitted'}
      chips={<StatusChip state={report.state_class} />}
      details={
        <>
          <Details items={[
            { label: 'Weather', value: report.weather },
            { label: 'Entries', value: <span className="num">{entries.length}</span> },
            { label: 'Reported', value: <span className="num">{reported.toLocaleString()}</span> },
            { label: 'Verified', value: <span className="num">{verified.toLocaleString()}</span> },
            { label: 'Notes', value: report.notes },
          ]} />
          {entries.length > 0 ? (
            <div className="scroll-x" style={{ marginTop: 'var(--s4)' }}>
              <table className="table">
                <thead><tr>
                  <th>Work item</th><th>Location</th>
                  <th className="n">Reported</th><th className="n">Verified</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>{e.work_item}</td>
                      <td className="small muted">{e.location}</td>
                      <td className="n num">{Number(e.reported_qty).toLocaleString()} {e.unit}</td>
                      {/* Blank, not zero: nothing has been confirmed yet, and
                          a zero would read as "confirmed as none". */}
                      <td className="n num">
                        {e.verified_qty === null ? <span className="muted">—</span>
                          : `${Number(e.verified_qty).toLocaleString()} ${e.unit}`}
                      </td>
                      <td><StatusChip state={STATE_OF[e.verification_status] ?? 'draft'}
                                      label={e.verification_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      }
      evidence={<EvidenceStrip assets={assets}
                               emptyHint="No photographs attached to the report itself" />}
      timeline={<Timeline events={trail} />}
    />
  );
}

const STATE_OF: Record<string, string> = {
  reported: 'submitted', verified: 'verified', adjusted: 'in_progress',
  rejected: 'rejected', superseded: 'cancelled',
};
