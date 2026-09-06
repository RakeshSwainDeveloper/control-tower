import { useEffect, useState, type FormEvent } from 'react';
import { Activity, Eye, ShieldAlert, StopCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-A03 — Health and impersonation, on one page.
 *
 * They belong together because the reason to impersonate is almost always
 * something the health page just showed you.
 *
 * Impersonation here is READ-ONLY, time-boxed, requires a written reason, and
 * is visible to the tenant while it runs. A support tool that can quietly
 * become the customer is not a support tool.
 */
interface Health {
  status: string;
  checks?: Record<string, { status: string; latency_ms?: number; detail?: string }>;
  queue?: { name: string; waiting: number; active: number; failed: number }[];
  sync_backlog?: number;
  storage?: { objects?: number; bytes?: number };
}
interface Session {
  id: string; org_id: string; org_name?: string | null;
  target_user_id: string; target_name?: string | null;
  reason: string; started_at: string; expires_at: string; ended_at?: string | null;
}

export function AdminHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [h, s] = await Promise.all([
        api.get<Health>('/health/ready').catch(() => api.get<Health>('/health')),
        api.get<{ data: Session[] } | Session[]>('/platform/impersonation')
          .then((r) => (Array.isArray(r) ? r : r.data ?? []))
          .catch(() => [] as Session[]),
      ]);
      setHealth(h);
      setSessions(s);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    void load();
    // A health page that does not refresh is a screenshot.
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, []);

  const end = async (id: string) => {
    await api.del(`/platform/impersonation/${id}`);
    await load();
  };

  if (loading) return <Loading label="Checking the platform" />;

  const live = sessions.filter((s) => !s.ended_at && new Date(s.expires_at) > new Date());

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <h1>Health &amp; impersonation</h1>
      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      <section className="stack">
        <h2 className="label">Health</h2>
        <div style={{ display: 'grid', gap: 'var(--s3)',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }}>
          <Tile label="Overall" value={health?.status ?? 'unknown'}
                good={health?.status === 'ok'} icon={Activity} />
          {Object.entries(health?.checks ?? {}).map(([name, c]) => (
            <Tile key={name} label={name} value={c.status}
                  detail={c.latency_ms !== undefined ? `${c.latency_ms} ms` : c.detail}
                  good={c.status === 'up' || c.status === 'ok'} icon={Activity} />
          ))}
          {(health?.queue ?? []).map((q) => (
            <Tile key={q.name} label={`queue · ${q.name}`}
                  value={`${q.waiting} waiting`}
                  detail={`${q.active} active · ${q.failed} failed`}
                  good={q.failed === 0} icon={Activity} />
          ))}
          {health?.sync_backlog !== undefined ? (
            <Tile label="Sync backlog" value={String(health.sync_backlog)}
                  good={health.sync_backlog < 100} icon={Activity} />
          ) : null}
        </div>
      </section>

      <section className="stack">
        <h2 className="label">Impersonation</h2>
        {live.length > 0 ? (
          <div className="banner banner-warn" role="status">
            <ShieldAlert size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
            <div className="stack-2 grow">
              <strong>{live.length} session{live.length === 1 ? '' : 's'} running right now</strong>
              <span className="small">The tenant sees a banner for the whole duration.</span>
            </div>
          </div>
        ) : null}

        <StartImpersonation onDone={() => void load()} />

        {sessions.length === 0 ? <EmptyState message="No impersonation has ever been started." /> : (
          <div className="card scroll-x">
            <table className="table">
              <thead><tr>
                <th>Organization</th><th>Acting as</th><th>Reason</th>
                <th>Started</th><th>Expires</th><th />
              </tr></thead>
              <tbody>
                {sessions.map((s) => {
                  const active = !s.ended_at && new Date(s.expires_at) > new Date();
                  return (
                    <tr key={s.id}>
                      <td className="small">{s.org_name ?? s.org_id.slice(0, 8)}</td>
                      <td className="small">{s.target_name ?? s.target_user_id.slice(0, 8)}</td>
                      <td className="small">{s.reason}</td>
                      <td className="xs num muted">{new Date(s.started_at).toLocaleString()}</td>
                      <td className="xs num muted">{new Date(s.expires_at).toLocaleString()}</td>
                      <td>
                        {active ? (
                          <button type="button" className="btn btn-sm btn-danger"
                                  onClick={() => void end(s.id)}>
                            <StopCircle size={14} aria-hidden /> End now
                          </button>
                        ) : <span className="xs muted">ended</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, detail, good, icon: Icon }: {
  label: string; value: string; detail?: string; good?: boolean;
  icon: typeof Activity;
}) {
  return (
    <div className="card card-p stack-2" style={{ padding: 'var(--s4)' }}>
      <span className="row xs muted" style={{ gap: 'var(--s2)' }}>
        <Icon size={13} aria-hidden /> {label}
      </span>
      <strong style={{ color: good === undefined ? undefined
                : good ? 'var(--st-verified)' : 'var(--destructive)' }}>
        {value}
      </strong>
      {detail ? <span className="xs muted num">{detail}</span> : null}
    </div>
  );
}

function StartImpersonation({ onDone }: { onDone: () => void }) {
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/platform/impersonation', { orgId, userId, reason, minutes });
      setReason(''); setUserId('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Could not start', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack-2" onSubmit={submit}>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
        <label className="field"><span className="label">Organization id</span>
          <input className="input" style={{ width: '18rem' }} required value={orgId}
                 onChange={(e) => setOrgId(e.target.value)} />
        </label>
        <label className="field"><span className="label">User id</span>
          <input className="input" style={{ width: '18rem' }} required value={userId}
                 onChange={(e) => setUserId(e.target.value)} />
        </label>
        <label className="field grow"><span className="label">Reason (recorded, minimum 10 characters)</span>
          <input className="input" required minLength={10} value={reason}
                 onChange={(e) => setReason(e.target.value)}
                 placeholder="Ticket 4821 — supervisor cannot submit their daily report" />
        </label>
        <label className="field"><span className="label">Minutes</span>
          <select className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[5, 15, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button className="btn btn-danger" type="submit" disabled={busy || reason.trim().length < 10}>
          {busy ? <span className="spinner" aria-hidden /> : <Eye size={16} aria-hidden />}
          Start read-only session
        </button>
      </div>
      <span className="xs muted">
        Read-only, time-boxed, and shown to the tenant while it runs. Every action
        taken during the session is attributed to you, not to them.
      </span>
    </form>
  );
}
