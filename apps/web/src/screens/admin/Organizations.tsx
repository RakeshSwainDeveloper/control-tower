import { useEffect, useState, type FormEvent } from 'react';
import { Building, Pause, Play, Plus, ToggleLeft, ToggleRight } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';
import { StatusChip } from '../../components/StatusChip.js';

/**
 * S-A01 — Organizations.
 *
 * Create, suspend, reactivate, set feature flags, invite the first Company
 * Admin. Every state change on this screen takes a written reason, because
 * suspending a tenant stops a construction site from recording work and the
 * platform audit log is the only place that decision is ever explained.
 */
interface Org {
  id: string; legal_name: string; display_name: string; slug: string;
  status: string; created_at: string; user_count?: number; project_count?: number;
}
interface Flag { key: string; description: string; default_enabled: boolean }

const STATE_FOR: Record<string, string> = {
  trial: 'submitted', active: 'verified', suspended: 'on_hold',
  read_only: 'in_review', closed: 'cancelled',
};

export function Organizations() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [selected, setSelected] = useState<Org | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [o, f] = await Promise.all([
        api.get<{ data: Org[] }>('/platform/organizations'),
        api.get<{ data: Flag[] }>('/platform/flags').catch(() => ({ data: [] })),
      ]);
      setOrgs(o.data ?? []);
      setFlags(f.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const setStatus = async (org: Org, status: string) => {
    const reason = window.prompt(
      `Why is ${org.display_name} moving to "${status}"?\n\n` +
      'This is written to the platform audit log and cannot be edited later.');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post(`/platform/organizations/${org.id}/status`, { status, reason: reason.trim() });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Status change failed', status: 0 }));
    }
  };

  if (loading) return <Loading label="Loading organizations" />;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Organizations</h1>
          <p className="small muted">{orgs.length} tenant{orgs.length === 1 ? '' : 's'}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden /> New organization
        </button>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}
      {creating ? <CreateOrgForm onDone={() => { setCreating(false); void load(); }}
                                 onCancel={() => setCreating(false)} /> : null}

      {orgs.length === 0 ? <EmptyState message="No organizations yet." /> : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr>
              <th>Organization</th><th>Slug</th><th>Status</th>
              <th className="n">Users</th><th className="n">Projects</th><th>Created</th><th />
            </tr></thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0 }}
                            onClick={() => setSelected(selected?.id === o.id ? null : o)}>
                      <Building size={15} aria-hidden /> {o.display_name}
                    </button>
                    <div className="xs muted">{o.legal_name}</div>
                  </td>
                  <td><code className="xs">{o.slug}</code></td>
                  <td><StatusChip state={STATE_FOR[o.status] ?? 'draft'} label={o.status} /></td>
                  <td className="n">{o.user_count ?? '—'}</td>
                  <td className="n">{o.project_count ?? '—'}</td>
                  <td className="xs muted">{new Date(o.created_at).toLocaleDateString()}</td>
                  <td>
                    {o.status === 'suspended' ? (
                      <button type="button" className="btn btn-sm" onClick={() => void setStatus(o, 'active')}>
                        <Play size={14} aria-hidden /> Reactivate
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-danger"
                              onClick={() => void setStatus(o, 'suspended')}>
                        <Pause size={14} aria-hidden /> Suspend
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? <OrgFlags org={selected} flags={flags} onError={setError} /> : null}
    </div>
  );
}

function OrgFlags({ org, flags, onError }: {
  org: Org; flags: Flag[]; onError: (e: ApiError) => void;
}) {
  const [state, setState] = useState<Record<string, boolean>>(
    () => Object.fromEntries(flags.map((f) => [f.key, f.default_enabled])));

  const toggle = async (key: string) => {
    const enabled = !state[key];
    const reason = window.prompt(`Why turn ${key} ${enabled ? 'on' : 'off'} for ${org.display_name}?`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post(`/platform/organizations/${org.id}/flags`,
                     { flagKey: key, enabled, reason: reason.trim() });
      setState((s) => ({ ...s, [key]: enabled }));
    } catch (e) {
      onError(e instanceof ApiError ? e : new ApiError({ title: 'Flag change failed', status: 0 }));
    }
  };

  return (
    <section className="stack">
      <h2 className="label">Feature flags · {org.display_name}</h2>
      {flags.length === 0 ? <p className="small muted">No flags defined.</p> : (
        <ul className="stack-2">
          {flags.map((f) => (
            <li key={f.key} className="card card-p row-between" style={{ padding: 'var(--s3) var(--s4)' }}>
              <span className="stack-2 grow" style={{ gap: 0 }}>
                <strong className="small">{f.key}</strong>
                <span className="xs muted">{f.description}</span>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void toggle(f.key)}>
                {state[f.key] ? <ToggleRight size={16} aria-hidden /> : <ToggleLeft size={16} aria-hidden />}
                {state[f.key] ? 'On' : 'Off'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateOrgForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/platform/organizations', {
        legalName, displayName, slug,
        ...(adminEmail ? { adminEmail, adminName: adminName || displayName } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Create failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack" onSubmit={submit}>
      <h2 className="label">New organization</h2>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
        <label className="field grow"><span className="label">Legal name</span>
          <input className="input" required value={legalName}
                 onChange={(e) => { setLegalName(e.target.value); if (!displayName) setDisplayName(e.target.value); }} />
        </label>
        <label className="field grow"><span className="label">Display name</span>
          <input className="input" required value={displayName}
                 onChange={(e) => {
                   setDisplayName(e.target.value);
                   // Slug is derived, not typed. It appears in URLs forever and
                   // a typo here is permanent.
                   setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                     .replace(/^-|-$/g, '').slice(0, 50));
                 }} />
        </label>
        <label className="field"><span className="label">Slug</span>
          <input className="input" required value={slug} onChange={(e) => setSlug(e.target.value)}
                 pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]" />
        </label>
      </div>
      <div className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
        <label className="field grow"><span className="label">First company admin — name</span>
          <input className="input" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
        </label>
        <label className="field grow"><span className="label">Their email</span>
          <input className="input" type="email" value={adminEmail}
                 onChange={(e) => setAdminEmail(e.target.value)} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || !legalName || !slug}>
          {busy ? <span className="spinner" aria-hidden /> : <Plus size={16} aria-hidden />} Create
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
      <span className="xs muted">
        An organization with no admin cannot be used by anyone. Naming one here
        sends the first invitation with the tenant.
      </span>
    </form>
  );
}
