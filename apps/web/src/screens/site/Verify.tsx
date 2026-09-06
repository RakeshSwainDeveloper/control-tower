import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Pencil, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-M09 — Verification. Target: 20 seconds per entry.
 *
 * The claim, the photographs, and the context needed to judge it. Three
 * outcomes, and the two that disagree with the supervisor both demand a reason.
 *
 *   ACCEPT   the claim stands as reported
 *   ADJUST   a different quantity, and WHY
 *   REJECT   nothing is credited, and WHY
 *
 * The rule this screen is built around is change **C-3**: an adjustment does
 * NOT overwrite `reported_qty`. The claim and the confirmation are separate
 * columns, so the gap between what site says and what was confirmed survives —
 * and that gap is the signal the whole product exists to surface (FR-146).
 * A screen that presented adjustment as "correcting the number" would teach
 * the opposite, so it presents both.
 */
interface Entry {
  id: string; reported_qty: string; verified_qty: string | null;
  verification_status: string; unit: string;
  work_item: string; work_item_code: string; location: string;
  contractor_label: string | null; note: string | null;
  reported_at: string; reported_by: string; reported_by_name: string | null;
  reported_responsibility: string | null;
  is_over_execution: boolean;
}

export function Verify() {
  const { entryId } = useParams();
  const { projectId, me } = useSession();
  const nav = useNavigate();

  const [entry, setEntry] = useState<Entry | null>(null);
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [decision, setDecision] = useState<'accept' | 'adjust' | 'reject' | null>(null);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!projectId || !entryId) return;
    void (async () => {
      try {
        const r = await api.get<{ data: Entry[] }>(
          `/projects/${projectId}/progress?limit=50`);
        const found = (r.data ?? []).find((e) => e.id === entryId) ?? null;
        setEntry(found);
        if (found) setQty(String(Number(found.reported_qty)));
        setAssets(await loadEvidence('progress_entry', entryId).catch(() => []));
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
      } finally { setLoading(false); }
    })();
  }, [projectId, entryId]);

  if (loading) return <Loading label="Loading the claim" />;
  if (!entry) return <ErrorBanner error={new ApiError({ title: 'Entry not found', status: 404 })} />;

  /**
   * SoD-02, shown before it is enforced.
   *
   * The server refuses this regardless. Hiding the controls means a site
   * engineer who recorded the work is never invited to sign it off and then
   * told no — which is the difference between a rule they understand and a
   * system that seems arbitrary.
   */
  const ownClaim = entry.reported_by === me?.user_id;

  const submit = async () => {
    if (!decision) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/${projectId}/progress/${entry.id}/verify`, {
        decision,
        ...(decision === 'adjust' ? { verifiedQty: qty } : {}),
        ...(decision !== 'accept' ? { reason } : {}),
      });
      nav('/site/work', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not record', status: 0 }));
    } finally { setBusy(false); }
  };

  const needsReason = decision === 'adjust' || decision === 'reject';
  const ready = decision === 'accept'
    || (decision === 'adjust' && qty.trim() !== '' && reason.trim().length >= 3)
    || (decision === 'reject' && reason.trim().length >= 3);

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
              onClick={() => nav(-1)}>
        <ArrowLeft size={18} aria-hidden /> Verify
      </button>

      {error ? <ErrorBanner error={error} /> : null}

      {/* The claim, large. This is the number being judged. */}
      <div className="card card-p stack-2">
        <span className="label">Claimed</span>
        <div className="row" style={{ alignItems: 'baseline', gap: 'var(--s2)' }}>
          <strong className="num" style={{ fontSize: 'var(--text-num)' }}>
            {Number(entry.reported_qty).toLocaleString()}
          </strong>
          <span className="muted" style={{ fontSize: 'var(--text-lg)' }}>{entry.unit}</span>
        </div>
        <span>{entry.work_item}</span>
        <span className="small muted">{entry.location}</span>
        <span className="xs muted">
          by {entry.reported_by_name ?? 'unknown'}
          {entry.reported_responsibility ? ` as ${entry.reported_responsibility}` : ''}
          {' · '}{new Date(entry.reported_at).toLocaleString()}
          {entry.contractor_label ? ` · ${entry.contractor_label}` : ''}
        </span>
        {entry.note ? <p className="small">{entry.note}</p> : null}
        {entry.is_over_execution ? (
          <div className="banner banner-warn">
            This is more than the planned quantity for this location.
          </div>
        ) : null}
      </div>

      <section className="stack-2">
        <h2 className="label">Evidence</h2>
        <EvidenceStrip assets={assets}
                       emptyHint="No photographs were attached to this claim" />
      </section>

      {ownClaim ? (
        <div className="banner banner-warn" role="note">
          <div className="stack-2">
            <strong>You recorded this yourself</strong>
            <span className="small">
              Somebody else has to verify it (SoD-02). That is not a permission
              problem — it is the point of verification.
            </span>
          </div>
        </div>
      ) : (
        <>
          <section className="stack-2">
            <h2 className="label">Decision</h2>
            <div className="row" style={{ gap: 'var(--s2)' }}>
              <Choice active={decision === 'accept'} onClick={() => setDecision('accept')}
                      icon={Check} label="Accept" tone="var(--st-verified)" />
              <Choice active={decision === 'adjust'} onClick={() => setDecision('adjust')}
                      icon={Pencil} label="Adjust" tone="var(--st-progress)" />
              <Choice active={decision === 'reject'} onClick={() => setDecision('reject')}
                      icon={X} label="Reject" tone="var(--destructive)" />
            </div>
          </section>

          {decision === 'adjust' ? (
            <label className="field">
              <span className="label">Confirmed quantity</span>
              <div className="row" style={{ gap: 'var(--s2)' }}>
                <input className="input input-qty grow" type="text" inputMode="decimal"
                       value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                       aria-label="Confirmed quantity" />
                <span className="muted" style={{ fontSize: 'var(--text-lg)' }}>{entry.unit}</span>
              </div>
              {/* C-3 made visible. The claim is not being corrected; it is
                  being disagreed with, and both numbers are kept. */}
              <p className="xs muted">
                {Number(entry.reported_qty).toLocaleString()} claimed →{' '}
                {qty ? Number(qty).toLocaleString() : '—'} confirmed. The claim is
                kept as it was recorded; the difference is what the office sees.
              </p>
            </label>
          ) : null}

          {needsReason ? (
            <label className="field">
              <span className="label">
                Why {decision === 'adjust' ? 'the different quantity' : 'this is rejected'}
              </span>
              <textarea className="textarea" value={reason} rows={3}
                        onChange={(e) => setReason(e.target.value)}
                        aria-label="Reason"
                        placeholder="Measured 9 sqm on site, not 12" />
              <span className="xs muted">
                This is shown to whoever recorded it. Write what you would say to
                them on site.
              </span>
            </label>
          ) : null}

          <button type="button" className="btn btn-primary btn-block"
                  disabled={!ready || busy} onClick={() => void submit()}
                  style={{ minHeight: '3.5rem', fontSize: 'var(--text-lg)' }}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            {decision === 'accept' ? 'ACCEPT THE CLAIM'
              : decision === 'adjust' ? 'RECORD THE ADJUSTMENT'
              : decision === 'reject' ? 'REJECT'
              : 'CHOOSE A DECISION'}
          </button>
        </>
      )}
    </div>
  );
}

function Choice({ active, onClick, icon: Icon, label, tone }: {
  active: boolean; onClick: () => void; icon: typeof Check; label: string; tone: string;
}) {
  return (
    <button type="button" className="chip-select grow" aria-pressed={active} onClick={onClick}
            style={active ? { background: tone, borderColor: tone, color: '#fff' } : undefined}>
      <Icon size={18} aria-hidden /> {label}
    </button>
  );
}
