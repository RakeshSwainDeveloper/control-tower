import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, HelpCircle, PauseCircle, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Timeline, type TimelineEvent } from '../../components/RecordPage.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-M13 — Approval decision. Target: 40 seconds.
 *
 * "The object, full context on one page, no navigation." That sentence from
 * the screen list is the whole design. An approver who has to leave the screen
 * to see what they are approving will either stop approving or start approving
 * without looking, and the second is worse.
 *
 * Deliberately NOT offline-capable. A decision made from a stale copy is a
 * decision about something that may already have changed — and unlike a
 * progress entry, an approval cannot be reconciled after the fact.
 *
 * Four outcomes. Three of them require words:
 *   APPROVE  the only one that needs nothing
 *   REJECT   sends it back, ended
 *   QUERY    a question to the submitter; the item stays open and the ageing
 *            clock KEEPS RUNNING (FR-201)
 *   HOLD     pauses the decision without discarding it
 */
interface Task {
  task_id: string; project_id: string; assigned_at: string; sla_due_at: string | null;
  instance_id: string; object_type: string; object_id: string; status: string;
  submitted_at: string; submitted_by_name: string | null; submitted_responsibility: string | null;
  step_no: number; step_name: string;
  project_code: string | null; project_name: string | null;
}

type Decision = 'approve' | 'reject' | 'query' | 'hold';

export function ApprovalDecision() {
  const { taskId } = useParams();
  const nav = useNavigate();
  const { responsibilityFor } = useSession();

  const [task, setTask] = useState<Task | null>(null);
  const [object, setObject] = useState<Record<string, unknown> | null>(null);
  const [entries, setEntries] = useState<Record<string, unknown>[]>([]);
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [trail, setTrail] = useState<TimelineEvent[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const inbox = await api.get<{ data: Task[] }>('/me/approvals');
        const t = (inbox.data ?? []).find((x) => x.task_id === taskId) ?? null;
        setTask(t);
        if (!t) return;

        // Everything the approver needs, fetched here so the screen itself
        // never navigates.
        if (t.object_type === 'daily_report') {
          const r = await api.get<{ report: Record<string, unknown>; entries: Record<string, unknown>[] }>(
            `/projects/${t.project_id}/daily-report?reportId=${t.object_id}`).catch(() => null);
          if (r) { setObject(r.report); setEntries(r.entries ?? []); }
        } else if (t.object_type === 'issue_closure') {
          const r = await api.get<{ data: Record<string, unknown>[] }>(
            `/projects/${t.project_id}/issues?limit=200`).catch(() => null);
          setObject((r?.data ?? []).find((i) => i['id'] === t.object_id) ?? null);
        }

        setAssets(await loadEvidence(
          t.object_type === 'issue_closure' ? 'issue' : t.object_type, t.object_id,
        ).catch(() => []));

        const tr = await api.get<{ decisions: {
          decided_at: string; decision: string; comment: string | null;
          decided_by_name?: string | null; responsibility_label?: string | null;
        }[] }>(`/approvals/${t.object_type}/${t.object_id}/trail`).catch(() => null);
        setTrail((tr?.decisions ?? []).map((d) => ({
          at: d.decided_at,
          action: WORD[d.decision] ?? d.decision,
          actor: d.decided_by_name ?? null,
          responsibility: d.responsibility_label ?? null,
          detail: d.comment,
        })));
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
      } finally { setLoading(false); }
    })();
  }, [taskId]);

  const submit = async () => {
    if (!decision || !task) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/approvals/${task.task_id}/decide`, {
        decision, ...(comment ? { comment } : {}),
      });
      nav('/site/work', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not record', status: 0 }));
    } finally { setBusy(false); }
  };

  if (loading) return <Loading label="Loading what you are approving" />;
  if (!task) {
    return (
      <div className="stack">
        <div className="banner banner-warn">
          <div className="stack-2">
            <strong>This is no longer waiting for you</strong>
            <span className="small">
              Somebody else may have decided it, or it was withdrawn.
            </span>
          </div>
        </div>
        <button type="button" className="btn" onClick={() => nav('/site/work')}>Back to My Work</button>
      </div>
    );
  }

  const needsWords = decision === 'reject' || decision === 'query';
  const ready = decision === 'approve' || decision === 'hold'
    || (needsWords && comment.trim().length >= 3);
  const ageHours = Math.floor((Date.now() - new Date(task.assigned_at).getTime()) / 3_600_000);
  const overdue = !!task.sla_due_at && new Date(task.sla_due_at).getTime() < Date.now();

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
              onClick={() => nav('/site/work')}>
        <ArrowLeft size={18} aria-hidden /> Approval
      </button>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="card card-p stack-2">
        <div className="row-between wrap" style={{ gap: 'var(--s2)' }}>
          <strong>{TITLE[task.object_type] ?? task.object_type}</strong>
          <StatusChip state="in_approval" label={task.step_name} />
        </div>
        <span className="small muted">
          {task.project_code} · submitted by {task.submitted_by_name ?? 'unknown'}
          {task.submitted_responsibility ? ` as ${task.submitted_responsibility}` : ''}
        </span>
        <span className="xs" style={{ color: overdue ? 'var(--destructive)' : 'var(--muted-fg)',
                                      fontWeight: overdue ? 600 : 400 }}>
          Waiting {ageHours < 1 ? 'less than an hour' : `${ageHours} hours`}
          {overdue ? ' · past its SLA' : ''}
        </span>
      </div>

      {/* The object itself. This is what "no navigation" means. */}
      {task.object_type === 'daily_report' && object ? (
        <section className="stack-2">
          <h2 className="label">The day being approved</h2>
          <div className="card card-p stack-2">
            <div className="row-between">
              <span className="small muted">Date</span>
              <strong className="small">
                {new Date(String(object['report_date'])).toDateString()}
              </strong>
            </div>
            <div className="row-between">
              <span className="small muted">Weather</span>
              <strong className="small">{String(object['weather'] ?? '—')}</strong>
            </div>
            {object['notes'] ? <p className="small">{String(object['notes'])}</p> : null}
          </div>
          <ul className="stack-2">
            {entries.map((e) => (
              <li key={String(e['id'])} className="list-row">
                <span className="grow stack-2" style={{ gap: 0, minWidth: 0 }}>
                  <strong className="truncate small">{String(e['work_item'])}</strong>
                  <span className="xs muted truncate">{String(e['location'])}</span>
                </span>
                <span className="num small" style={{ flex: 'none', textAlign: 'right' }}>
                  <strong>{Number(e['reported_qty']).toLocaleString()}</strong>
                  <span className="muted"> {String(e['unit'])}</span>
                  {/* What was actually confirmed, next to what was claimed —
                      the approver is signing off the day, and the difference
                      between the two is the thing worth seeing. */}
                  {e['verified_qty'] !== null && e['verified_qty'] !== undefined ? (
                    <span className="xs muted" style={{ display: 'block' }}>
                      confirmed {Number(e['verified_qty']).toLocaleString()}
                    </span>
                  ) : (
                    <span className="xs" style={{ display: 'block', color: 'var(--st-progress)' }}>
                      not verified
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {task.object_type === 'issue_closure' && object ? (
        <section className="stack-2">
          <h2 className="label">The issue being closed</h2>
          <div className="card card-p stack-2">
            <strong>{String(object['title'])}</strong>
            <span className="small muted">
              {String(object['issue_number'] ?? '')} · {String(object['severity'])}
            </span>
            {object['resolution_note'] ? (
              <p className="small">{String(object['resolution_note'])}</p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="stack-2">
        <h2 className="label">Evidence</h2>
        <EvidenceStrip assets={assets} emptyHint="No photographs attached" />
      </section>

      {trail.length > 0 ? (
        <section className="stack-2">
          <h2 className="label">Already decided</h2>
          <Timeline events={trail} />
        </section>
      ) : null}

      <section className="stack-2">
        <h2 className="label">Your decision</h2>
        <div className="row wrap" style={{ gap: 'var(--s2)' }}>
          <Choice d="approve" active={decision} set={setDecision} icon={Check}
                  label="Approve" tone="var(--st-verified)" />
          <Choice d="query" active={decision} set={setDecision} icon={HelpCircle}
                  label="Ask" tone="var(--st-submitted)" />
          <Choice d="hold" active={decision} set={setDecision} icon={PauseCircle}
                  label="Hold" tone="var(--st-progress)" />
          <Choice d="reject" active={decision} set={setDecision} icon={X}
                  label="Reject" tone="var(--destructive)" />
        </div>
      </section>

      {needsWords ? (
        <label className="field">
          <span className="label">
            {decision === 'query' ? 'What do you need to know?' : 'Why is this rejected?'}
          </span>
          <textarea className="textarea" rows={3} value={comment} aria-label="Comment"
                    onChange={(e) => setComment(e.target.value)}
                    placeholder={decision === 'query'
                      ? 'Was the same mix used on the second pour?'
                      : 'Quantities do not match the measurements taken on Tuesday'} />
          {decision === 'query' ? (
            /* FR-201, said out loud. A question that stops the clock is the
               cheapest way to make an overdue item look on time. */
            <span className="xs muted">
              This goes back to {task.submitted_by_name ?? 'the submitter'}. The item
              stays open and keeps ageing while you wait for an answer.
            </span>
          ) : null}
        </label>
      ) : decision === 'hold' ? (
        <p className="xs muted">
          Pauses your decision without discarding it. It comes back to you.
        </p>
      ) : null}

      <button type="button" className="btn btn-primary btn-block"
              disabled={!ready || busy} onClick={() => void submit()}
              style={{ minHeight: '3.5rem', fontSize: 'var(--text-lg)' }}>
        {busy ? <span className="spinner" aria-hidden /> : null}
        {decision ? VERB[decision] : 'CHOOSE A DECISION'}
      </button>
      {decision === 'approve' ? (
        <p className="xs muted" style={{ textAlign: 'center' }}>
          Recorded against you as {responsibilityFor('approval.task.decide') ?? 'your role'}.
        </p>
      ) : null}
    </div>
  );
}

function Choice({ d, active, set, icon: Icon, label, tone }: {
  d: Decision; active: Decision | null; set: (d: Decision) => void;
  icon: typeof Check; label: string; tone: string;
}) {
  const on = active === d;
  return (
    <button type="button" className="chip-select grow" aria-pressed={on} onClick={() => set(d)}
            style={on ? { background: tone, borderColor: tone, color: '#fff' } : undefined}>
      <Icon size={18} aria-hidden /> {label}
    </button>
  );
}

const TITLE: Record<string, string> = {
  daily_report: 'Daily report', issue_closure: 'Issue closure',
};
const WORD: Record<string, string> = {
  approve: 'Approved', reject: 'Rejected', query: 'Question raised', hold: 'Put on hold',
};
const VERB: Record<Decision, string> = {
  approve: 'APPROVE', reject: 'REJECT', query: 'SEND THE QUESTION', hold: 'PUT ON HOLD',
};
