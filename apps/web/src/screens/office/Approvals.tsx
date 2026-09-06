import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Clock, HelpCircle, PauseCircle, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W06 — Approvals inbox.
 *
 * "One list across both object types, sorted by ageing, with the oldest age
 * prominent." Three requirements, and the third is the one that changes
 * behaviour: a count tells an approver they have work, an age tells them they
 * are the reason something is stuck.
 *
 * The ageing numbers come from the server (`count`, `oldest_age_hours`,
 * `overdue`) rather than being derived here. A client that computed them would
 * eventually compute them differently from the dashboard, and then there would
 * be two answers to "how far behind are we".
 *
 * Decisions are taken inline. Bouncing to a record page per approval is what
 * turns a morning's inbox into an afternoon's.
 */
interface Task {
  task_id: string; project_id: string; assigned_at: string; sla_due_at: string | null;
  instance_id: string; object_type: string; object_id: string;
  submitted_at: string; submitted_by_name: string | null; submitted_responsibility: string | null;
  step_no: number; step_name: string;
  project_code: string | null; project_name: string | null;
  age_hours: number; overdue: boolean;
}
interface Inbox {
  count: number; oldest_age_hours: number; overdue: number; data: Task[];
}

type Decision = 'approve' | 'reject' | 'query' | 'hold';

const AGE = (h: number) =>
  h < 1 ? 'under an hour' : h < 48 ? `${h}h` : `${Math.floor(h / 24)} days`;

export function Approvals() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setInbox(await api.get<Inbox>('/me/approvals'));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  if (loading) return <Loading label="Loading your approvals" />;

  const tasks = inbox?.data ?? [];

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Approvals</h1>
          <p className="small muted">
            Everything waiting on you, across every kind of record, oldest first.
          </p>
        </div>
        {/* The oldest age, prominent. It is the number that says whether the
            approver is the bottleneck. */}
        {tasks.length > 0 ? (
          <div className="row" style={{ gap: 'var(--s4)' }}>
            <Headline value={String(inbox!.count)} label="waiting" />
            <Headline value={AGE(inbox!.oldest_age_hours)} label="oldest"
                      warn={inbox!.oldest_age_hours >= 24} />
            {inbox!.overdue > 0 ? (
              <Headline value={String(inbox!.overdue)} label="past SLA" warn />
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      {tasks.length === 0 ? (
        <EmptyState message="Nothing is waiting for your approval." />
      ) : (
        <ul className="stack-2">
          {tasks.map((t) => (
            <Row key={t.task_id} task={t} expanded={openId === t.task_id}
                 onToggle={() => setOpenId(openId === t.task_id ? null : t.task_id)}
                 onDecided={() => { setOpenId(null); void load(); }} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Headline({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="stack-2" style={{ gap: 0, textAlign: 'right' }}>
      <strong className="num" style={{ fontSize: 'var(--text-xl)',
        color: warn ? 'var(--destructive)' : undefined }}>{value}</strong>
      <span className="xs muted">{label}</span>
    </div>
  );
}

function Row({ task, expanded, onToggle, onDecided }: {
  task: Task; expanded: boolean; onToggle: () => void; onDecided: () => void;
}) {
  const nav = useNavigate();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const decide = async () => {
    if (!decision) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/approvals/${task.task_id}/decide`, {
        decision, ...(comment ? { comment } : {}),
      });
      onDecided();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not record', status: 0 }));
    } finally { setBusy(false); }
  };

  const needsWords = decision === 'reject' || decision === 'query';
  const ready = decision === 'approve' || decision === 'hold'
    || (needsWords && comment.trim().length >= 3);

  return (
    <li className="card" style={{
      borderLeft: task.overdue ? '3px solid var(--destructive)' : undefined,
    }}>
      <button type="button" onClick={onToggle} aria-expanded={expanded}
              className="row" style={{ width: '100%', padding: 'var(--s3) var(--s4)',
                                       background: 'none', border: 0, textAlign: 'left',
                                       gap: 'var(--s4)' }}>
        <span className="grow stack-2" style={{ gap: 2, minWidth: 0 }}>
          <strong className="truncate">
            {TITLE[task.object_type] ?? task.object_type}
            {task.project_code ? <span className="muted"> · {task.project_code}</span> : null}
          </strong>
          <span className="xs muted truncate">
            {task.step_name} · submitted by {task.submitted_by_name ?? 'unknown'}
            {task.submitted_responsibility ? ` as ${task.submitted_responsibility}` : ''}
          </span>
        </span>
        <span className="row xs num" style={{ flex: 'none', gap: 'var(--s2)',
          color: task.overdue ? 'var(--destructive)' : 'var(--muted-fg)',
          fontWeight: task.overdue ? 600 : 400 }}>
          <Clock size={13} aria-hidden />
          {AGE(task.age_hours)}
          {task.overdue ? ' · late' : ''}
        </span>
      </button>

      {expanded ? (
        <div className="stack" style={{ padding: '0 var(--s4) var(--s4)' }}>
          {error ? <ErrorBanner error={error} /> : null}

          <div className="row wrap" style={{ gap: 'var(--s2)' }}>
            <Btn d="approve" active={decision} set={setDecision} icon={Check}
                 label="Approve" tone="var(--st-verified)" />
            <Btn d="query" active={decision} set={setDecision} icon={HelpCircle}
                 label="Ask a question" tone="var(--st-submitted)" />
            <Btn d="hold" active={decision} set={setDecision} icon={PauseCircle}
                 label="Hold" tone="var(--st-progress)" />
            <Btn d="reject" active={decision} set={setDecision} icon={X}
                 label="Reject" tone="var(--destructive)" />
            <span className="grow" />
            {/* The full-context view, for when the row is not enough. Offered,
                not required — that is the difference between this and a list
                that forces a page load per decision. */}
            <button type="button" className="btn btn-sm"
                    onClick={() => nav(`/site/approvals/${task.task_id}`)}>
              See everything
            </button>
          </div>

          {needsWords ? (
            <label className="field">
              <span className="label">
                {decision === 'query' ? 'Your question' : 'Why this is rejected'}
              </span>
              <input className="input" value={comment} aria-label="Comment"
                     onChange={(e) => setComment(e.target.value)}
                     placeholder={decision === 'query'
                       ? 'Was the same mix used on the second pour?'
                       : 'Quantities do not match Tuesday’s measurements'} />
              {decision === 'query' ? (
                <span className="xs muted">
                  Goes back to {task.submitted_by_name ?? 'the submitter'}. The item stays
                  open and keeps ageing while you wait (FR-201).
                </span>
              ) : null}
            </label>
          ) : null}

          {decision ? (
            <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}
                    disabled={!ready || busy} onClick={() => void decide()}>
              {busy ? <span className="spinner" aria-hidden /> : null} Record decision
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Btn({ d, active, set, icon: Icon, label, tone }: {
  d: Decision; active: Decision | null; set: (d: Decision) => void;
  icon: typeof Check; label: string; tone: string;
}) {
  const on = active === d;
  return (
    <button type="button" className="btn btn-sm" aria-pressed={on} onClick={() => set(d)}
            style={on ? { background: tone, borderColor: tone, color: '#fff' } : undefined}>
      <Icon size={14} aria-hidden /> {label}
    </button>
  );
}

const TITLE: Record<string, string> = {
  daily_report: 'Daily report', issue_closure: 'Issue closure',
};
