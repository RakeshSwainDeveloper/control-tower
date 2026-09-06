import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Send, ShieldPlus, Trash2, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Can } from '../../components/Gate.js';
import { StatusChip } from '../../components/StatusChip.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W09 — Users, roles and grants.
 *
 * The screen list is explicit that the role EDITOR sits behind a secondary
 * action: the common job is "give Ramesh Site Supervisor on Tower B", and a
 * screen that leads with a 52-checkbox permission matrix makes that job feel
 * like systems administration. So: invite, then grant a preset role to a
 * scope. Editing what a role means is a different, rarer task.
 *
 * A grant carries a responsibility label because that label is what the audit
 * trail will print — "approved as Project Manager" — and it is worth letting a
 * company choose its own words for it.
 */

interface User { id: string; name: string; email: string | null; phone: string | null; status: string }
interface Role { id: string; code: string; name: string; is_system: boolean; permission_count?: number }
interface Grant {
  id: string; user_id: string; role_id: string; role_name?: string;
  scope_type: string; scope_id: string | null; responsibility_label: string;
  scope_label?: string | null;
}

export function People() {
  const { projects, can } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [u, r] = await Promise.all([
        api.get<{ data: User[] }>('/users?limit=200'),
        can('org.role.read') ? api.get<{ data: Role[] }>('/roles') : Promise.resolve({ data: [] }),
      ]);
      setUsers(u.data ?? []);
      setRoles(r.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const openUser = async (id: string) => {
    setSelected(id);
    try {
      const g = await api.get<{ data: Grant[] }>(`/grants?user_id=${id}`);
      setGrants(g.data ?? []);
    } catch { setGrants([]); }
  };

  const revoke = async (grantId: string) => {
    await api.del(`/grants/${grantId}`);
    if (selected) await openUser(selected);
  };

  if (loading) return <Loading label="Loading people" />;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Users, roles &amp; grants</h1>
          <p className="small muted">
            Who is on this organisation, what they may do, and where.
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <Can perm="org.user.create">
            <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>
              <UserPlus size={16} aria-hidden /> Invite
            </button>
          </Can>
          {/* Secondary, as specified: the role editor is not the front door. */}
          <Can perm="org.role.create">
            <a className="btn" href="#roles"><ShieldPlus size={16} aria-hidden /> Roles</a>
          </Can>
        </div>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      {inviting ? (
        <InviteForm roles={roles} projects={projects}
                    onDone={() => { setInviting(false); void load(); }}
                    onCancel={() => setInviting(false)} />
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--s5)' }}>
        <section className="stack">
          <h2 className="label">People ({users.length})</h2>
          {users.length === 0 ? <EmptyState message="Nobody has been invited yet." /> : (
            <ul className="stack-2">
              {users.map((u) => (
                <li key={u.id}>
                  <button type="button" className="list-row" onClick={() => void openUser(u.id)}
                          style={selected === u.id ? { borderColor: 'var(--accent)' } : undefined}>
                    <span className="grow stack-2" style={{ gap: 0 }}>
                      <strong>{u.name}</strong>
                      <span className="xs muted">{u.email ?? u.phone ?? '—'}</span>
                    </span>
                    <StatusChip state={u.status === 'active' ? 'verified'
                      : u.status === 'invited' ? 'submitted'
                      : u.status === 'suspended' ? 'on_hold' : 'cancelled'} label={u.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stack">
          <h2 className="label">
            {selected ? `Grants · ${users.find((u) => u.id === selected)?.name ?? ''}` : 'Grants'}
          </h2>
          {!selected ? (
            <p className="small muted">Select a person to see and change what they may do.</p>
          ) : (
            <>
              {grants.length === 0 ? (
                <p className="small muted">
                  No grants. This person can sign in and see nothing — which is the
                  correct starting state, not a bug.
                </p>
              ) : (
                <ul className="stack-2">
                  {grants.map((g) => (
                    <li key={g.id} className="card card-p row-between" style={{ padding: 'var(--s3) var(--s4)' }}>
                      <span className="stack-2 grow" style={{ gap: 0 }}>
                        <strong className="small">{g.responsibility_label}</strong>
                        <span className="xs muted">
                          {g.role_name ?? g.role_id.slice(0, 8)} ·{' '}
                          {g.scope_type === 'org' ? 'whole organisation'
                            : g.scope_label ?? projects.find((p) => p.id === g.scope_id)?.name ?? 'a project'}
                        </span>
                      </span>
                      <Can perm="org.grant.manage">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(g.id)}>
                          <Trash2 size={14} aria-hidden /><span className="sr-only">Revoke</span>
                        </button>
                      </Can>
                    </li>
                  ))}
                </ul>
              )}
              <Can perm="org.grant.manage">
                <GrantForm userId={selected} roles={roles} projects={projects}
                           onDone={() => void openUser(selected)} />
              </Can>
            </>
          )}
        </section>
      </div>

      <section className="stack" id="roles">
        <h2 className="label">Roles ({roles.length})</h2>
        <ul className="stack-2">
          {roles.map((r) => (
            <li key={r.id} className="card card-p row-between" style={{ padding: 'var(--s3) var(--s4)' }}>
              <span className="stack-2 grow" style={{ gap: 0 }}>
                <strong className="small">{r.name}</strong>
                <span className="xs muted">{r.code}</span>
              </span>
              {r.is_system ? <span className="chip" style={{
                background: 'var(--st-draft-bg)', color: 'var(--st-draft)' }}>Preset</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function InviteForm({ roles, projects, onDone, onCancel }: {
  roles: Role[]; projects: { id: string; name: string; code: string }[];
  onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [scopeId, setScopeId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const isEmail = contact.includes('@');
    try {
      await api.post('/invitations', {
        name,
        ...(isEmail ? { email: contact } : { phone: contact }),
        grants: roleId ? [{
          roleId,
          scopeType: scopeId ? 'project' : 'org',
          ...(scopeId ? { scopeId } : {}),
        }] : [],
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Invite failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack" onSubmit={submit}>
      <h2 className="label">Invite someone</h2>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
        <label className="field grow"><span className="label">Name</span>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field grow">
          {/* One field, not two. Site people have a phone; office people have an
              email; nobody should have to decide which box they belong in. */}
          <span className="label">Email or mobile</span>
          <input className="input" required value={contact} onChange={(e) => setContact(e.target.value)}
                 placeholder="ramesh@example.com or +91…" />
        </label>
        <label className="field"><span className="label">Role</span>
          <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">Scope</span>
          <select className="select" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="">Whole organisation</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || !name || !contact}>
          {busy ? <span className="spinner" aria-hidden /> : <Send size={16} aria-hidden />} Send invite
        </button>
        <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function GrantForm({ userId, roles, projects, onDone }: {
  userId: string; roles: Role[]; projects: { id: string; name: string; code: string }[];
  onDone: () => void;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [scopeId, setScopeId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/grants', {
        userId, roleId,
        scopeType: scopeId ? 'project' : 'org',
        ...(scopeId ? { scopeId } : {}),
        ...(label ? { responsibilityLabel: label } : {}),
      });
      setLabel('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Grant failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack-2" onSubmit={submit}>
      {error ? <ErrorBanner error={error} /> : null}
      <div className="row wrap" style={{ gap: 'var(--s2)', alignItems: 'flex-end' }}>
        <label className="field grow"><span className="label">Role</span>
          <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label className="field grow"><span className="label">On</span>
          <select className="select" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="">Whole organisation</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span className="label">Called (optional)</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)}
                 placeholder="Site Supervisor" />
        </label>
        <button className="btn" type="submit" disabled={busy || !roleId}>
          <Plus size={15} aria-hidden /> Grant
        </button>
      </div>
      <span className="xs muted">
        The words you choose here are what the audit trail prints — “approved as
        {label ? ` ${label}` : ' Project Manager'}”.
      </span>
    </form>
  );
}
