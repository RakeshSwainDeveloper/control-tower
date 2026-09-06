import { AlertTriangle, Inbox, RefreshCw, WifiOff } from 'lucide-react';
import type { ApiError } from '../lib/api.js';

/**
 * A spinner in the middle of an empty page reads as "stuck"; a shimmer over
 * the shape of what is coming reads as "loading". On 4G that difference is
 * several seconds of somebody deciding whether the app is broken — so the
 * default is now a skeleton, and the spinner is kept for the inline case
 * where something small is already on screen.
 */
export function Loading({ label = 'Loading', inline = false }:
  { label?: string; inline?: boolean }) {
  if (inline) {
    return (
      <div className="row muted small" style={{ padding: 'var(--s4)', gap: 'var(--s2)' }} role="status">
        <span className="spinner" aria-hidden /> {label}…
      </div>
    );
  }
  return (
    <div className="stack" role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div className="skeleton" style={{ height: '1.75rem', width: '40%' }} aria-hidden />
      <div className="skeleton" style={{ height: '0.875rem', width: '25%' }} aria-hidden />
      <div className="stack-2" style={{ marginTop: 'var(--s3)' }} aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton"
               style={{ height: '3.25rem', borderRadius: 'var(--r-md)', opacity: 1 - i * 0.12 }} />
        ))}
      </div>
    </div>
  );
}

/** A fixed number of skeleton rows, for a list whose length is known. */
export function SkeletonRows({ rows = 5, height = '3.25rem' }:
  { rows?: number; height?: string }) {
  return (
    <div className="stack-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, borderRadius: 'var(--r-md)' }} />
      ))}
    </div>
  );
}

/**
 * An empty state says what is absent and, where there is one, offers the next
 * step. The icon sits in a tinted disc rather than floating: an unframed grey
 * glyph on a white card reads as a rendering failure.
 */
export function EmptyState({ message, action, icon: Icon = Inbox, title }:
  { message: string; action?: React.ReactNode; icon?: typeof Inbox; title?: string }) {
  return (
    <div className="empty card">
      <span aria-hidden style={{
        display: 'grid', placeItems: 'center', width: 48, height: 48,
        borderRadius: 'var(--r-full)', background: 'var(--bg-subtle)',
        border: '1px solid var(--border)',
      }}>
        <Icon size={22} aria-hidden />
      </span>
      <div className="stack-2" style={{ gap: 'var(--s1)' }}>
        {title ? <strong style={{ color: 'var(--fg)' }}>{title}</strong> : null}
        <p className="small">{message}</p>
      </div>
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
  // status 0 covers both "no network" and "the request never landed". Only the
  // first is the offline condition; the second is a fault worth showing plainly.
  const offline = error.status === 0 && error.problem.title === 'No connection';
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
