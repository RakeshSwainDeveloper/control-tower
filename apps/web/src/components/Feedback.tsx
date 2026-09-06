import { AlertTriangle, Inbox, RefreshCw, WifiOff } from 'lucide-react';
import type { ApiError } from '../lib/api.js';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="row muted small" style={{ padding: 'var(--s4)', gap: 'var(--s2)' }} role="status">
      <span className="spinner" aria-hidden /> {label}…
    </div>
  );
}

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="empty card">
      <Inbox size={28} aria-hidden />
      <p>{message}</p>
      {action}
    </div>
  );
}

/**
 * Error rendering, with one rule: show the server's own words.
 *
 * The API writes `detail` for the person reading the screen — "You cannot
 * verify a quantity you reported yourself (SoD-02)". Replacing that with
 * "Something went wrong" turns a comprehensible refusal into a mystery, and
 * mysteries become support calls.
 *
 * A dead network (status 0) is not an error state: it is a condition, and it
 * gets the offline treatment rather than a red banner.
 */
export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const offline = error.status === 0;
  return (
    <div className={offline ? 'banner banner-warn' : 'banner banner-bad'} role="alert">
      {offline ? <WifiOff size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
               : <AlertTriangle size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />}
      <div className="stack-2 grow">
        <strong>{error.problem.title}</strong>
        {error.problem.detail ? <span>{error.problem.detail}</span> : null}
        {error.supportReference && !offline ? (
          <span className="xs">Reference {error.supportReference}</span>
        ) : null}
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden /> Retry
        </button>
      ) : null}
    </div>
  );
}

/** Inline field error, for forms the server rejected field-by-field. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span className="error" role="alert">{message}</span>;
}
