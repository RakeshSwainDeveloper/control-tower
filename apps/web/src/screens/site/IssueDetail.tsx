import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Check, MessageSquarePlus, RotateCcw, ShieldCheck, Wrench,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip, SeverityChip } from '../../components/StatusChip.js';
import { Timeline, type TimelineEvent } from '../../components/RecordPage.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';
import * as evidence from '../../lib/offline/evidence.js';

/**
 * S-M11 — Issue detail.
 *
 * Status, evidence, timeline, comments, and whichever of resolve / verify /
 * close / reopen this person may actually do. The lifecycle is enforced
 * server-side; this screen's job is to offer exactly one obvious next step and
 * to explain the refusals before they happen.
 *
 * Three of those explanations matter:
 *   · Resolving needs a photograph. An issue resolved with no evidence is a
 *     claim, and the whole product is built on claims carrying proof.
 *   · SoD-03 — whoever resolved it cannot verify it.
 *   · An unanswered question blocks closure, by database trigger.
 */
interface Issue {
  id: string; issue_number: string | null; title: string; description?: string | null;
  severity: string; state_class: string; category?: string | null;
  location?: string | null; assignee?: string | null; due_date: string | null;
  raised_at: string; raised_responsibility: string | null;
  resolved_at: string | null; verified_at: string | null; closed_at: string | null;
  reopen_count: number;
}
interface Comment {
  id: string; body: string; is_query: boolean; created_at: string;
  author: string | null; author_responsibility: string | null;
  addressed_to: string | null; answer_body: string | null;
  answered_at: string | null; answered_by_name: string | null;
}

export function IssueDetail() {
  const { issueId } = useParams();
  const { projectId, can, me } = useSession();
  const nav = useNavigate();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId || !issueId) return;
    try {
      const list = await api.get<{ data: Issue[] }>(`/projects/${projectId}/issues?limit=200`);
      setIssue((list.data ?? []).find((i) => i.id === issueId) ?? null);
      setAssets(await loadEvidence('issue', issueId).catch(() => []));
      const c = await api.get<{ data: Comment[] } | Comment[]>(
        `/projects/${projectId}/comments?entityType=issue&entityId=${issueId}`).catch(() => ({ data: [] }));
      setComments(Array.isArray(c) ? c : c.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  }, [projectId, issueId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/${projectId}/issues/${issueId}/${path}`, body ?? {});
      setNote('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not do that', status: 0 }));
    } finally { setBusy(false); }
  };

  const addClosurePhoto = async (files: FileList | null) => {
    if (!files?.length || !issueId) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const rec = await evidence.capture(f, {
          kind: 'photo', purpose: 'closure',
          ...(projectId ? { projectId } : {}),
          link: { entityType: 'issue', entityId: issueId },
        });
        await evidence.upload(rec.id);
        evidence.forget(rec.id);
      }
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Upload failed', status: 0 }));
    } finally { setUploading(false); }
  };

  if (loading) return <Loading label="Loading the issue" />;
  if (!issue) return <ErrorBanner error={new ApiError({ title: 'Issue not found', status: 404 })} />;

  const openQuery = comments.find((c) => c.is_query && !c.answered_at);
  const hasClosurePhoto = assets.length > 0;

  const events: TimelineEvent[] = [
    { at: issue.raised_at, action: 'Raised', responsibility: issue.raised_responsibility },
    ...(issue.resolved_at ? [{ at: issue.resolved_at, action: 'Resolved' }] : []),
    ...(issue.verified_at ? [{ at: issue.verified_at, action: 'Verified' }] : []),
    ...(issue.closed_at ? [{ at: issue.closed_at, action: 'Closed' }] : []),
  ];

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
              onClick={() => nav('/site/issues')}>
        <ArrowLeft size={18} aria-hidden /> Issue
      </button>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="stack-2">
        <div className="row wrap" style={{ gap: 'var(--s2)' }}>
          <StatusChip state={issue.state_class} />
          <SeverityChip severity={issue.severity} />
          {issue.reopen_count > 0 ? (
            /* A defect fixed three times is a different conversation from one
               fixed once, and the count is the only thing that says so. */
            <span className="chip" style={{ background: 'var(--st-rejected-bg)',
                                            color: 'var(--st-rejected)' }}>
              Reopened {issue.reopen_count}×
            </span>
          ) : null}
        </div>
        <h1>{issue.title}</h1>
        <p className="small muted">
          {issue.issue_number ? `${issue.issue_number} · ` : ''}
          {issue.category ?? 'Uncategorised'}
          {issue.location ? ` · ${issue.location}` : ''}
        </p>
        {issue.description ? <p className="small">{issue.description}</p> : null}
        {issue.assignee ? <p className="xs muted">Assigned to {issue.assignee}</p> : null}
        {issue.due_date ? (
          <p className="xs" style={{
            color: new Date(issue.due_date) < new Date() && issue.state_class !== 'closed'
              ? 'var(--destructive)' : 'var(--muted-fg)' }}>
            Due {new Date(issue.due_date).toDateString()}
          </p>
        ) : null}
      </div>

      <section className="stack-2">
        <h2 className="label">Evidence</h2>
        <EvidenceStrip assets={assets} emptyHint="No photographs yet" />
      </section>

      {/* ── The one next step ─────────────────────────────────── */}
      {issue.state_class === 'closed' || issue.state_class === 'cancelled' ? null : (
        <section className="stack-2">
          <h2 className="label">What happens next</h2>

          {issue.state_class !== 'resolved' && issue.state_class !== 'verified'
            && can('issue.issue.resolve') ? (
            <div className="card card-p stack-2">
              <strong className="small">Fixed it?</strong>
              {!hasClosurePhoto ? (
                <>
                  <p className="small muted">
                    Attach a photograph of the completed work first. An issue
                    resolved with no photo is a claim, not a fix.
                  </p>
                  <label className="btn" style={{ alignSelf: 'flex-start' }}>
                    {uploading ? <span className="spinner" aria-hidden /> : null}
                    Add the photo
                    <input type="file" accept="image/*" capture="environment" className="sr-only"
                           onChange={(e) => { void addClosurePhoto(e.target.files); e.target.value = ''; }} />
                  </label>
                </>
              ) : (
                <>
                  <input className="input" value={note} aria-label="What was done"
                         onChange={(e) => setNote(e.target.value)}
                         placeholder="Chipped out and repacked with grout" />
                  <button type="button" className="btn btn-primary"
                          disabled={busy || note.trim().length < 3}
                          onClick={() => void act('resolve', { note })}>
                    <Wrench size={16} aria-hidden /> Mark it resolved
                  </button>
                </>
              )}
            </div>
          ) : null}

          {issue.state_class === 'resolved' && can('issue.issue.verify') ? (
            <div className="card card-p stack-2">
              <strong className="small">Check the work</strong>
              <p className="small muted">
                Whoever resolved it cannot verify it (SoD-03). If that was you,
                somebody else has to look.
              </p>
              <button type="button" className="btn btn-primary" disabled={busy}
                      onClick={() => void act('verify')}>
                <ShieldCheck size={16} aria-hidden /> Verify it
              </button>
            </div>
          ) : null}

          {issue.state_class === 'verified' && can('issue.issue.close') ? (
            <div className="card card-p stack-2">
              <strong className="small">Close it</strong>
              {openQuery ? (
                <p className="small" style={{ color: 'var(--destructive)' }}>
                  There is an unanswered question on this issue. It cannot close
                  until somebody answers it.
                </p>
              ) : (issue.severity === 'high' || issue.severity === 'critical') ? (
                <p className="small muted">
                  A {issue.severity} issue also needs an approved closure.
                </p>
              ) : null}
              <button type="button" className="btn btn-primary" disabled={busy || !!openQuery}
                      onClick={() => void act('close')}>
                <Check size={16} aria-hidden /> Close it
              </button>
            </div>
          ) : null}
        </section>
      )}

      {(issue.state_class === 'closed' || issue.state_class === 'verified')
        && can('issue.issue.reopen') ? (
        <button type="button" className="btn" disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why is this being reopened?');
                  if (reason && reason.trim().length >= 3) void act('reopen', { reason: reason.trim() });
                }}>
          <RotateCcw size={16} aria-hidden /> Reopen
        </button>
      ) : null}

      <section className="stack-2">
        <h2 className="label">Comments</h2>
        {comments.length === 0 ? <p className="small muted">Nothing said yet.</p> : (
          <ul className="stack-2">
            {comments.map((c) => (
              <li key={c.id} className="card card-p stack-2" style={{ padding: 'var(--s3) var(--s4)' }}>
                <div className="row-between">
                  <strong className="small">
                    {c.author ?? 'Unknown'}
                    {c.author_responsibility ? <span className="muted"> as {c.author_responsibility}</span> : null}
                  </strong>
                  {c.is_query ? (
                    <span className="chip" style={{
                      background: c.answered_at ? 'var(--st-verified-bg)' : 'var(--st-progress-bg)',
                      color: c.answered_at ? 'var(--st-verified)' : 'var(--st-progress)' }}>
                      {c.answered_at ? 'Answered' : 'Question'}
                    </span>
                  ) : null}
                </div>
                <p className="small">{c.body}</p>
                {c.answer_body ? (
                  <p className="small" style={{ borderLeft: '2px solid var(--border)',
                                                paddingLeft: 'var(--s3)' }}>
                    {c.answer_body}
                    <span className="xs muted"> — {c.answered_by_name ?? 'answered'}</span>
                  </p>
                ) : c.is_query && c.addressed_to === me?.user_id ? (
                  <AnswerBox projectId={projectId!} commentId={c.id} onAnswered={() => void load()} />
                ) : null}
                <span className="xs muted">{new Date(c.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="row" style={{ gap: 'var(--s2)' }}>
          <input className="input grow" value={comment} aria-label="Add a comment"
                 onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" />
          <button type="button" className="btn" disabled={busy || !comment.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.post(`/projects/${projectId}/comments`, {
                        entityType: 'issue', entityId: issueId, body: comment.trim(),
                      });
                      setComment(''); await load();
                    } catch (e) {
                      setError(e instanceof ApiError ? e : null);
                    } finally { setBusy(false); }
                  }}>
            <MessageSquarePlus size={16} aria-hidden /><span className="sr-only">Add</span>
          </button>
        </div>
      </section>

      <section className="stack-2">
        <h2 className="label">Timeline</h2>
        <Timeline events={events} />
      </section>
    </div>
  );
}

function AnswerBox({ projectId, commentId, onAnswered }: {
  projectId: string; commentId: string; onAnswered: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ gap: 'var(--s2)' }}>
      <input className="input grow" value={text} aria-label="Your answer"
             onChange={(e) => setText(e.target.value)} placeholder="Your answer" />
      <button type="button" className="btn btn-sm" disabled={busy || !text.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post(`/projects/${projectId}/comments/${commentId}/answer`,
                                 { answer: text.trim() });
                  onAnswered();
                } finally { setBusy(false); }
              }}>
        Answer
      </button>
    </div>
  );
}
