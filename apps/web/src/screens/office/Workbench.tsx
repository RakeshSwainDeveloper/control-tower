import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronDown, Pencil, X } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip } from '../../components/StatusChip.js';
import { MetricValue } from '../../components/DrillLink.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W04 — Progress & verification workbench.
 *
 * The office counterpart to S-M09. A site engineer sitting at a desk with
 * forty claims to get through needs three things a phone screen cannot give
 * them: everything on one page, evidence inline rather than a tap away, and
 * the reported-vs-verified gap in front of them the whole time.
 *
 * The gap is at the top and stays there. It is the number the product exists
 * to surface (FR-146), and a workbench that only showed rows would let someone
 * verify forty entries without ever noticing that claims are outrunning
 * confirmation.
 *
 * Rows expand in place. Opening a record page per entry is what makes bulk
 * verification take an afternoon.
 */
interface Entry {
  id: string; reported_qty: string; verified_qty: string | null;
  verification_status: string; verification_reason: string | null;
  unit: string; work_item: string; work_item_code: string; location: string;
  contractor_label: string | null; note: string | null;
  reported_at: string; reported_by: string; reported_by_name: string | null;
  reported_responsibility: string | null;
  verified_by_name: string | null; verified_responsibility: string | null;
  is_over_execution: boolean;
}

interface Gap {
  metric: string; value: number; unit: string; as_of: string; definition: string;
  breakdown: {
    reported_total: number; verified_total: number; variance: number;
    entries: number; verified_entries: number; awaiting_verification: number;
    adjusted: number; rejected: number; over_execution: number;
  };
  drill?: { endpoint?: string; params?: Record<string, unknown> };
}

export function Workbench() {
  const { projectId, me, can } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Entry[]>([]);
  const [gap, setGap] = useState<Gap | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const status = params.get('status') ?? 'reported';

  const load = async () => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [list, g] = await Promise.all([
        api.get<{ data: Entry[] }>(
          `/projects/${projectId}/progress${qs({ limit: 100, status: status || undefined })}`),
        api.get<Gap>(`/projects/${projectId}/progress/verification-gap`),
      ]);
      setRows(list.data ?? []);
      setGap(g);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [projectId, status]);

  const setStatus = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('status', v); else next.delete('status');
    setParams(next, { replace: true });
  };

  if (loading && rows.length === 0) return <Loading label="Loading the workbench" />;

  const b = gap?.breakdown;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="stack-2">
        <h1>Progress &amp; verification</h1>
        <p className="small muted">
          Claims from site, and what has been confirmed against them.
        </p>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      {/* The gap, permanently in view. */}
      {gap && b ? (
        <div style={{ display: 'grid', gap: 'var(--s3)',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
          <MetricValue
            value={`${Math.round(gap.value)}%`} label="reported but not yet verified"
            metric={gap} to="/office/progress?status=reported" />
          <MetricValue value={b.reported_total.toLocaleString()} label="reported" />
          <MetricValue value={b.verified_total.toLocaleString()} label="verified" />
          <MetricValue value={b.awaiting_verification.toLocaleString()}
                       label="entries awaiting a verifier" />
          {b.adjusted > 0 || b.rejected > 0 ? (
            <MetricValue value={`${b.adjusted} / ${b.rejected}`} label="adjusted / rejected" />
          ) : null}
        </div>
      ) : null}

      <div className="row wrap" style={{ gap: 'var(--s2)' }}>
        {[['reported', 'Awaiting verification'], ['verified', 'Verified'],
          ['adjusted', 'Adjusted'], ['rejected', 'Rejected'], ['', 'Everything']].map(([v, label]) => (
          <button key={v} type="button" className={status === v ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                  onClick={() => setStatus(v!)}>
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState message={
          status === 'reported'
            ? 'Nothing is waiting to be verified. Site is up to date, or nothing has been recorded.'
            : 'Nothing here.'} />
      ) : (
        <ul className="stack-2">
          {rows.map((e) => (
            <Row key={e.id} entry={e} projectId={projectId!}
                 expanded={open === e.id}
                 canVerify={can('field.progress.verify')}
                 isOwn={e.reported_by === me?.user_id}
                 onToggle={() => setOpen(open === e.id ? null : e.id)}
                 onVerified={() => { setOpen(null); void load(); }} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ entry, projectId, expanded, canVerify, isOwn, onToggle, onVerified }: {
  entry: Entry; projectId: string; expanded: boolean;
  canVerify: boolean; isOwn: boolean;
  onToggle: () => void; onVerified: () => void;
}) {
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [decision, setDecision] = useState<'accept' | 'adjust' | 'reject' | null>(null);
  const [qty, setQty] = useState(String(Number(entry.reported_qty)));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!expanded) return;
    void loadEvidence('progress_entry', entry.id).then(setAssets).catch(() => setAssets([]));
  }, [expanded, entry.id]);

  const submit = async () => {
    if (!decision) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/${projectId}/progress/${entry.id}/verify`, {
        decision,
        ...(decision === 'adjust' ? { verifiedQty: qty } : {}),
        ...(decision !== 'accept' ? { reason } : {}),
      });
      onVerified();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not record', status: 0 }));
    } finally { setBusy(false); }
  };

  const ready = decision === 'accept'
    || (decision === 'adjust' && qty.trim() !== '' && reason.trim().length >= 3)
    || (decision === 'reject' && reason.trim().length >= 3);

  const gap = entry.verified_qty !== null
    ? Number(entry.reported_qty) - Number(entry.verified_qty) : null;

  return (
    <li className="card">
      <button type="button" className="row" onClick={onToggle} aria-expanded={expanded}
              style={{ width: '100%', padding: 'var(--s3) var(--s4)', background: 'none',
                       border: 0, textAlign: 'left', gap: 'var(--s4)' }}>
        <span className="grow stack-2" style={{ gap: 2, minWidth: 0 }}>
          <strong className="truncate">{entry.work_item}</strong>
          <span className="xs muted truncate">
            {entry.location} · {entry.reported_by_name ?? 'unknown'}
            {entry.reported_responsibility ? ` as ${entry.reported_responsibility}` : ''}
            {' · '}{new Date(entry.reported_at).toLocaleDateString()}
          </span>
        </span>

        {/* Claimed and confirmed, side by side. Never one number replacing the
            other — that is change C-3, and it is the whole point of the column. */}
        <span className="num" style={{ textAlign: 'right', flex: 'none' }}>
          <span style={{ fontWeight: 600 }}>{Number(entry.reported_qty).toLocaleString()}</span>
          <span className="muted small"> {entry.unit}</span>
          {entry.verified_qty !== null ? (
            <span className="xs muted" style={{ display: 'block' }}>
              confirmed {Number(entry.verified_qty).toLocaleString()}
              {gap ? <span style={{ color: 'var(--st-progress)' }}> ({gap > 0 ? '−' : '+'}{Math.abs(gap)})</span> : null}
            </span>
          ) : null}
        </span>

        <StatusChip state={STATE_OF[entry.verification_status] ?? 'draft'}
                    label={entry.verification_status} />
        <ChevronDown size={18} aria-hidden className="muted"
                     style={{ flex: 'none', transform: expanded ? 'rotate(180deg)' : undefined,
                              transition: 'transform var(--dur) var(--ease)' }} />
      </button>

      {expanded ? (
        <div className="stack" style={{ padding: '0 var(--s4) var(--s4)' }}>
          {entry.note ? <p className="small">{entry.note}</p> : null}
          {entry.contractor_label ? (
            <p className="xs muted">Contractor: {entry.contractor_label}</p>
          ) : null}
          {entry.is_over_execution ? (
            <div className="banner banner-warn">More than the planned quantity for this location.</div>
          ) : null}
          {entry.verification_reason ? (
            <div className="banner">
              <div className="stack-2">
                <strong className="small">
                  {entry.verification_status === 'rejected' ? 'Rejected' : 'Adjusted'} by{' '}
                  {entry.verified_by_name ?? 'unknown'}
                  {entry.verified_responsibility ? ` as ${entry.verified_responsibility}` : ''}
                </strong>
                <span className="small">{entry.verification_reason}</span>
              </div>
            </div>
          ) : null}

          <EvidenceStrip assets={assets} emptyHint="No photographs were attached to this claim" />

          {error ? <ErrorBanner error={error} /> : null}

          {entry.verification_status !== 'reported' ? null
            : isOwn ? (
              <p className="small muted">
                You recorded this. Somebody else has to verify it (SoD-02).
              </p>
            ) : !canVerify ? null : (
              <div className="stack-2">
                <div className="row" style={{ gap: 'var(--s2)' }}>
                  <button type="button" className="btn btn-sm" aria-pressed={decision === 'accept'}
                          style={decision === 'accept'
                            ? { background: 'var(--st-verified)', borderColor: 'var(--st-verified)', color: '#fff' } : undefined}
                          onClick={() => setDecision('accept')}>
                    <Check size={14} aria-hidden /> Accept
                  </button>
                  <button type="button" className="btn btn-sm" aria-pressed={decision === 'adjust'}
                          style={decision === 'adjust'
                            ? { background: 'var(--st-progress)', borderColor: 'var(--st-progress)', color: '#fff' } : undefined}
                          onClick={() => setDecision('adjust')}>
                    <Pencil size={14} aria-hidden /> Adjust
                  </button>
                  <button type="button" className="btn btn-sm" aria-pressed={decision === 'reject'}
                          style={decision === 'reject'
                            ? { background: 'var(--destructive)', borderColor: 'var(--destructive)', color: '#fff' } : undefined}
                          onClick={() => setDecision('reject')}>
                    <X size={14} aria-hidden /> Reject
                  </button>
                </div>

                {decision === 'adjust' ? (
                  <label className="field">
                    <span className="label">Confirmed quantity ({entry.unit})</span>
                    <input className="input" style={{ maxWidth: '10rem' }} inputMode="decimal"
                           value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                           aria-label="Confirmed quantity" />
                  </label>
                ) : null}

                {decision === 'adjust' || decision === 'reject' ? (
                  <label className="field">
                    <span className="label">Reason (shown to whoever recorded it)</span>
                    <input className="input" value={reason} aria-label="Reason"
                           onChange={(e) => setReason(e.target.value)}
                           placeholder="Measured 9 sqm on site, not 12" />
                  </label>
                ) : null}

                {decision ? (
                  <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}
                          disabled={!ready || busy} onClick={() => void submit()}>
                    {busy ? <span className="spinner" aria-hidden /> : null}
                    Record decision
                  </button>
                ) : null}
              </div>
            )}
        </div>
      ) : null}
    </li>
  );
}

const STATE_OF: Record<string, string> = {
  reported: 'submitted', verified: 'verified', adjusted: 'in_progress',
  rejected: 'rejected', superseded: 'cancelled',
};
