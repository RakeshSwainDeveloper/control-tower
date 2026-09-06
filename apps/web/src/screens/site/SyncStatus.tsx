import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, RefreshCw, Trash2 } from 'lucide-react';
import { useSyncStatus, SyncNowButton } from '../../components/SyncBadge.js';
import * as outbox from '../../lib/offline/outbox.js';
import { EmptyState } from '../../components/Feedback.js';

/**
 * S-M15 — Sync status and Needs Attention.
 *
 * The screen that makes offline trustworthy. It shows the queue, the age of
 * the oldest item, and for anything the server refused, the server's own words
 * about why — with the supervisor's data still intact so they can correct and
 * resubmit rather than re-enter (FR-491).
 *
 * There is no "clear the queue" button. An unacknowledged item is somebody's
 * unrecorded morning; discarding it is a per-item decision taken after reading
 * the reason, never a bulk convenience.
 */
const AGE = (ms: number) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hours ago` : `${Math.floor(h / 24)} days ago`;
};

export function SyncStatus() {
  const status = useSyncStatus();
  const [items, setItems] = useState<outbox.OutboxItem[]>([]);

  const refresh = () => { void outbox.all().then(setItems); };
  useEffect(() => {
    refresh();
    return outbox.subscribe(refresh);
  }, []);

  const attention = items.filter((i) => i.state === 'attention' || i.state === 'conflict');
  const waiting = items.filter((i) => i.state === 'pending' || i.state === 'sending');

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row-between">
        <h1>Sync</h1>
        <SyncNowButton />
      </div>

      <div className="card card-p stack-2">
        <div className="row-between">
          <span className="small muted">Last sent</span>
          <strong className="small num">
            {status.lastSyncAt ? AGE(Date.now() - status.lastSyncAt) : 'not yet'}
          </strong>
        </div>
        <div className="row-between">
          <span className="small muted">Waiting to send</span>
          <strong className="small num">{status.pending}</strong>
        </div>
        {status.oldestPendingAt ? (
          <div className="row-between">
            <span className="small muted">Oldest waiting</span>
            {/* The number that matters. "3 waiting" is fine; "3 waiting, oldest
                6 hours" is a problem the supervisor can act on. */}
            <strong className="small num" style={{
              color: Date.now() - status.oldestPendingAt > 4 * 3600_000
                ? 'var(--st-progress)' : undefined }}>
              {AGE(Date.now() - status.oldestPendingAt)}
            </strong>
          </div>
        ) : null}
      </div>

      {attention.length > 0 ? (
        <section className="stack-2">
          <h2 className="label">Needs your attention ({attention.length})</h2>
          <ul className="stack-2">
            {attention.map((i) => (
              <li key={i.client_uuid} className="card card-p stack-2">
                <div className="row" style={{ gap: 'var(--s2)', alignItems: 'flex-start' }}>
                  <AlertCircle size={18} aria-hidden
                               style={{ flex: 'none', color: 'var(--destructive)', marginTop: 2 }} />
                  <div className="grow stack-2">
                    <strong className="small">{i.label}</strong>
                    {/* The server's own words, not a generic message. */}
                    <span className="small">{i.last_error}</span>
                    <span className="xs muted">
                      Recorded {AGE(Date.now() - i.queued_at)} · {i.attempts} attempt
                      {i.attempts === 1 ? '' : 's'} · your data is still here
                    </span>
                  </div>
                </div>
                <div className="row" style={{ gap: 'var(--s2)' }}>
                  <button type="button" className="btn btn-sm"
                          onClick={() => void outbox.update(i.client_uuid, { state: 'pending' })}>
                    <RefreshCw size={14} aria-hidden /> Try again
                  </button>
                  <button type="button" className="btn btn-sm btn-danger"
                          onClick={() => {
                            if (window.confirm(
                              `Discard "${i.label}"?\n\nThis cannot be undone and the work will not be recorded.`,
                            )) void outbox.discard(i.client_uuid);
                          }}>
                    <Trash2 size={14} aria-hidden /> Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="stack-2">
        <h2 className="label">Waiting to send ({waiting.length})</h2>
        {waiting.length === 0 ? (
          attention.length === 0 ? (
            <EmptyState message="Everything you have recorded has reached the office." />
          ) : <p className="small muted">Nothing else is waiting.</p>
        ) : (
          <ul className="stack-2">
            {waiting.map((i) => (
              <li key={i.client_uuid} className="list-row">
                {i.state === 'sending'
                  ? <span className="spinner" aria-hidden />
                  : <Clock size={18} aria-hidden className="muted" />}
                <span className="grow stack-2" style={{ gap: 0, minWidth: 0 }}>
                  <strong className="truncate small">{i.label}</strong>
                  <span className="xs muted">{AGE(Date.now() - i.queued_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {items.length === 0 && status.state !== 'offline' ? (
        <p className="row small muted" style={{ gap: 'var(--s2)' }}>
          <CheckCircle2 size={16} aria-hidden style={{ color: 'var(--st-verified)' }} />
          Nothing is queued on this device.
        </p>
      ) : null}
    </div>
  );
}
