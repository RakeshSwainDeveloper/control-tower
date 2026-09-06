import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck, HelpCircle, Inbox, MessageSquare, Stamp, TriangleAlert, Wrench,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { EmptyState, Loading } from '../../components/Feedback.js';

/**
 * S-M08 — My Work.
 *
 * One list. Approvals waiting on me, actions assigned to me, unanswered
 * questions addressed to me, unclaimed role-queue items, and issues I own —
 * ordered by what is late, not by which table the row came from.
 *
 * The server does the union and the ordering (change C-4). A client that
 * merged four endpoints would sort them differently from the office view, and
 * "how many things am I late on" would have two answers.
 */
interface WorkRow {
  kind: string; id: string; project_id: string; title: string;
  due_date: string | null; created_at: string;
  needs_acceptance: boolean; overdue: boolean;
}

const ICON: Record<string, typeof Inbox> = {
  approval: Stamp, task: ClipboardCheck, query: HelpCircle,
  instruction: MessageSquare, issue: TriangleAlert, review: ClipboardCheck,
  queue_task: Wrench, queue_query: Wrench, queue_instruction: Wrench,
};

const WORDS: Record<string, string> = {
  approval: 'Waiting for your approval',
  task: 'Task assigned to you',
  query: 'Question for you to answer',
  instruction: 'Instruction to acknowledge',
  issue: 'Issue assigned to you',
  queue_task: 'Unclaimed — anyone with your role',
  queue_query: 'Unclaimed question',
  queue_instruction: 'Unclaimed instruction',
};

const DUE = (row: WorkRow) => {
  if (!row.due_date) return null;
  const days = Math.round(
    (new Date(row.due_date).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} late`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
};

export function MyWork() {
  const { projectId } = useSession();
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    void api.get<{ data: WorkRow[] }>(
      `/me/work?limit=100${projectId ? `&projectId=${projectId}` : ''}`)
      .then((r) => setRows(r.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [projectId]);

  if (loading) return <Loading label="Getting your work" />;

  const late = rows.filter((r) => r.overdue);

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row-between">
        <h1>My Work</h1>
        {late.length > 0 ? (
          <span className="chip" style={{
            background: 'var(--st-rejected-bg)', color: 'var(--st-rejected)' }}>
            {late.length} late
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState message="Nothing is waiting for you. That is a good thing." />
      ) : (
        <ul className="stack-2">
          {rows.map((r) => {
            const Icon = ICON[r.kind] ?? Inbox;
            const due = DUE(r);
            return (
              <li key={`${r.kind}-${r.id}`}>
                <Link to={routeFor(r)} className="list-row"
                      style={{ textDecoration: 'none', color: 'inherit',
                               borderLeft: r.overdue ? '3px solid var(--destructive)' : undefined }}>
                  <Icon size={20} aria-hidden className="muted" style={{ flex: 'none' }} />
                  <span className="grow stack-2" style={{ gap: 2, minWidth: 0 }}>
                    <strong className="truncate">{r.title}</strong>
                    <span className="xs muted">
                      {WORDS[r.kind] ?? r.kind}
                      {r.needs_acceptance ? ' · tap to accept' : ''}
                    </span>
                  </span>
                  {due ? (
                    <span className="xs num" style={{
                      color: r.overdue ? 'var(--destructive)' : 'var(--muted-fg)',
                      fontWeight: r.overdue ? 600 : 400, textAlign: 'right', flex: 'none',
                    }}>
                      {due}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function routeFor(r: WorkRow): string {
  if (r.kind === 'approval') return `/site/approvals/${r.id}`;
  if (r.kind === 'issue') return `/site/issues/${r.id}`;
  return '/site/work';
}
