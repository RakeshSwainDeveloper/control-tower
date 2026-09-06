import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { SyncNowButton, useSyncStatus } from '../../components/SyncBadge.js';
import * as outbox from '../../lib/offline/outbox.js';

/**
 * S-M16 — Profile & settings.
 *
 * Project switch, who you are and in what capacity, sessions, sign out, and
 * local data purge. The purge is guarded by the queue: a supervisor who clears
 * local data with unsent work would lose a morning, so the button refuses
 * while anything is waiting rather than warning and proceeding.
 */
export function Profile() {
  const { me, projects, projectId, setProjectId, signOut } = useSession();
  const sync = useSyncStatus();
  const nav = useNavigate();
  const [purged, setPurged] = useState(false);

  // The responsibilities this person actually carries, deduplicated — this is
  // what the audit trail will say about anything they do today.
  const responsibilities = Array.from(new Set(
    (me?.permissions ?? []).map((p) => p.responsibility).filter(Boolean),
  ));

  const purge = async () => {
    const d = await outbox.db();
    await d.clear('cache');
    setPurged(true);
  };

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <h1>Profile</h1>

      <section className="stack">
        <h2 className="label">Project</h2>
        {projects.length === 0 ? (
          <p className="small muted">You are not assigned to a project yet.</p>
        ) : (
          <ul className="stack-2">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className="list-row" onClick={() => setProjectId(p.id)}
                        aria-pressed={p.id === projectId}
                        style={p.id === projectId
                          ? { borderColor: 'var(--accent)', background: 'var(--accent-weak)' } : undefined}>
                  <Building2 size={18} aria-hidden className="muted" />
                  <span className="grow stack-2" style={{ gap: 0 }}>
                    <strong>{p.name}</strong>
                    <span className="xs muted">{p.code}</span>
                  </span>
                  {p.id === projectId ? <span className="chip" style={{
                    background: 'var(--st-verified-bg)', color: 'var(--st-verified)' }}>Current</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stack">
        <h2 className="label">You act as</h2>
        <div className="card card-p stack-2">
          {responsibilities.length === 0
            ? <span className="small muted">No responsibilities granted yet.</span>
            : responsibilities.map((r) => (
                <span key={r} className="row small" style={{ gap: 'var(--s2)' }}>
                  <ShieldCheck size={16} aria-hidden className="muted" /> {r}
                </span>
              ))}
          {/* FR-030 made visible: this is the phrase that will appear against
              everything they record today. */}
          <p className="xs muted">
            Anything you record is signed with the responsibility you held at the time.
          </p>
        </div>
      </section>

      <section className="stack">
        <h2 className="label">Sync</h2>
        <div className="card card-p stack">
          <div className="row-between">
            <span className="small">
              {sync.pending} waiting · {sync.attention} need attention
            </span>
            <SyncNowButton />
          </div>
          <div className="stack-2">
            <button type="button" className="btn" onClick={() => void purge()}
                    disabled={sync.pending > 0 || sync.attention > 0}>
              <Trash2 size={16} aria-hidden /> Clear downloaded data
            </button>
            <span className="xs muted">
              {sync.pending > 0 || sync.attention > 0
                ? 'Cannot clear while work is still waiting to sync.'
                : purged
                  ? 'Cleared. Locations and work items will download again.'
                  : 'Removes cached locations and work items. Your unsent work is never touched.'}
            </span>
          </div>
        </div>
      </section>

      <button type="button" className="btn btn-danger btn-block"
              onClick={() => { void signOut().then(() => nav('/site/login')); }}>
        <LogOut size={18} aria-hidden /> Sign out
      </button>
    </div>
  );
}
