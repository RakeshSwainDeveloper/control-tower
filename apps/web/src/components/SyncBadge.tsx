import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, CloudOff, RefreshCw } from 'lucide-react';
import { onStatus, flush, type SyncStatus } from '../lib/offline/sync-engine.js';

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState<SyncStatus>({
    state: 'idle', pending: 0, attention: 0, lastSyncAt: null, oldestPendingAt: null,
  });
  useEffect(() => onStatus(setS), []);
  return s;
}

const AGO = (ms: number) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/**
 * The sync badge.
 *
 * It says how many items are waiting and how old the oldest one is, because
 * "3 waiting" is reassuring and "3 waiting, oldest 6 hours" is a problem the
 * supervisor can act on. A spinner alone tells them neither.
 */
export function SyncBadge({ to = '/site/sync' }: { to?: string }) {
  const s = useSyncStatus();
  const label =
    s.state === 'attention' ? `${s.attention} need${s.attention === 1 ? 's' : ''} attention`
    : s.state === 'syncing' ? 'Syncing…'
    : s.pending > 0 ? `${s.pending} waiting`
    : s.state === 'offline' ? 'Offline'
    : 'All synced';

  const icon =
    s.state === 'attention' ? <AlertCircle size={13} aria-hidden />
    : s.state === 'syncing' ? <span className="spinner" aria-hidden />
    : s.state === 'offline' ? <CloudOff size={13} aria-hidden />
    : s.pending > 0 ? <RefreshCw size={13} aria-hidden />
    : <Check size={13} aria-hidden />;

  const state = s.state === 'idle' && s.pending > 0 ? 'syncing' : s.state;

  return (
    <Link to={to} className="sync-badge" data-state={state} style={{ textDecoration: 'none' }}>
      {icon}
      <span>{label}</span>
      {s.oldestPendingAt && s.pending > 0 ? (
        <span className="xs" style={{ opacity: 0.8 }}>· oldest {AGO(Date.now() - s.oldestPendingAt)}</span>
      ) : null}
    </Link>
  );
}

export function SyncNowButton() {
  const s = useSyncStatus();
  return (
    <button type="button" className="btn btn-sm" onClick={() => void flush()}
            disabled={s.state === 'syncing' || s.state === 'offline'}>
      <RefreshCw size={14} aria-hidden /> Sync now
    </button>
  );
}
