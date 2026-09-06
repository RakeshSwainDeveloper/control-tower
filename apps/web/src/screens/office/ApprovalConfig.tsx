import { useEffect, useState, type FormEvent } from 'react';
import { GitBranch, History, Plus, Save } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Can } from '../../components/Gate.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W10 — Approval configuration.
 *
 * Definitions per object type; step, resolver, SLA; version history with a
 * diff. The version history is not a nicety: a published version is immutable
 * (BR-20), so "what were the rules when this was approved" has an answer, and
 * this screen is where somebody reads it.
 *
 * Editing therefore PUBLISHES rather than saves. The button says so.
 */
interface Step {
  step_no: number; name: string;
  resolver: 'role_in_project' | 'project_manager';
  role_code?: string; sla_hours?: number;
}
interface Version { id: string; version_no: number; spec: Step[]; activated_at: string }
interface Definition {
  id: string; object_type: string; name: string;
  scope_type: string; scope_id: string | null; is_active: boolean;
  current_version: number | null; steps: Step[]; in_flight: number; versions: Version[];
}
interface Role { id: string; code: string; name: string }

const OBJECT_TYPES = [
  { value: 'daily_report', label: 'Daily report' },
  { value: 'issue_closure', label: 'Issue closure (high & critical)' },
];

export function ApprovalConfig() {
  const { can } = useSession();
  const [defs, setDefs] = useState<Definition[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [d, r] = await Promise.all([
        api.get<{ data: Definition[] }>('/approval-definitions'),
        can('org.role.read') ? api.get<{ data: Role[] }>('/roles') : Promise.resolve({ data: [] }),
      ]);
      setDefs(d.data ?? []);
      setRoles(r.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const unconfigured = OBJECT_TYPES.filter((t) => !defs.some((d) => d.object_type === t.value));

  if (loading) return <Loading label="Loading approval workflows" />;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="row-between wrap">
        <div className="stack-2">
          <h1>Approval configuration</h1>
          <p className="small muted">
            A published version is never edited. Changing a workflow publishes a
            new version, and anything already in flight finishes under the rules
            it started on.
          </p>
        </div>
        <Can perm="approval.definition.configure">
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}
                  disabled={unconfigured.length === 0}>
            <Plus size={16} aria-hidden /> New workflow
          </button>
        </Can>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      {/* An object type with no workflow is not a blank slate — it is a
          submission that will be REFUSED (BR-22). Say so before it happens. */}
      {unconfigured.length > 0 ? (
        <div className="banner banner-warn">
          <div className="stack-2">
            <strong>
              {unconfigured.map((t) => t.label).join(' and ')} ha
              {unconfigured.length === 1 ? 's' : 've'} no approval workflow.
            </strong>
            <span className="small">
              Submitting one is refused rather than auto-approved — an approval no
              human made is worse than no control at all.
            </span>
          </div>
        </div>
      ) : null}

      {creating ? (
        <Editor roles={roles} objectTypes={unconfigured}
                onCancel={() => setCreating(false)}
                onDone={() => { setCreating(false); void load(); }} />
      ) : null}

      {defs.length === 0 && !creating ? (
        <EmptyState message="No approval workflows configured." />
      ) : (
        <ul className="stack">
          {defs.map((d) => <DefinitionCard key={d.id} def={d} roles={roles} onChanged={() => void load()} />)}
        </ul>
      )}
    </div>
  );
}

function DefinitionCard({ def, roles, onChanged }: {
  def: Definition; roles: Role[]; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);

  return (
    <li className="card card-p stack">
      <div className="row-between wrap">
        <div className="stack-2">
          <div className="row wrap" style={{ gap: 'var(--s2)' }}>
            <strong>{def.name}</strong>
            <span className="chip" style={{ background: 'var(--st-draft-bg)', color: 'var(--st-draft)' }}>
              {def.object_type}
            </span>
            <span className="chip" style={{
              background: def.is_active ? 'var(--st-verified-bg)' : 'var(--st-cancelled-bg)',
              color: def.is_active ? 'var(--st-verified)' : 'var(--st-cancelled)' }}>
              {def.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
          <span className="xs muted">
            Version {def.current_version} · {def.scope_type === 'org' ? 'whole organisation' : 'one project'}
            {def.in_flight > 0 ? ` · ${def.in_flight} in flight under an earlier version` : ''}
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <button type="button" className="btn btn-sm" onClick={() => setHistory((h) => !h)}>
            <History size={14} aria-hidden /> {def.versions.length} version{def.versions.length === 1 ? '' : 's'}
          </button>
          <Can perm="approval.definition.configure">
            <button type="button" className="btn btn-sm" onClick={() => setEditing((e) => !e)}>
              <GitBranch size={14} aria-hidden /> Publish a change
            </button>
          </Can>
        </div>
      </div>

      <StepChain steps={def.steps} />

      {history ? <VersionHistory versions={def.versions} /> : null}
      {editing ? (
        <Editor roles={roles} definition={def}
                onCancel={() => setEditing(false)}
                onDone={() => { setEditing(false); onChanged(); }} />
      ) : null}
    </li>
  );
}

function StepChain({ steps, muted }: { steps: Step[]; muted?: boolean }) {
  return (
    <ol className="row wrap" style={{ gap: 'var(--s2)', opacity: muted ? 0.65 : 1 }}>
      {steps.map((s, i) => (
        <li key={s.step_no} className="row" style={{ gap: 'var(--s2)' }}>
          <span className="card" style={{ padding: 'var(--s2) var(--s3)' }}>
            <span className="stack-2" style={{ gap: 0 }}>
              <strong className="small">{s.step_no}. {s.name}</strong>
              <span className="xs muted">
                {s.resolver === 'project_manager'
                  ? 'the project manager'
                  : `any ${s.role_code} on the project`}
                {s.sla_hours ? ` · ${s.sla_hours}h` : ''}
              </span>
            </span>
          </span>
          {i < steps.length - 1 ? <span className="muted" aria-hidden>→</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The diff is what makes history useful: "what changed" beats "what it was". */
function VersionHistory({ versions }: { versions: Version[] }) {
  return (
    <div className="stack-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s3)' }}>
      {versions.map((v, i) => {
        const prev = versions[i + 1];
        const changes = prev ? diff(prev.spec, v.spec) : ['First published version'];
        return (
          <div key={v.id} className="stack-2">
            <span className="row" style={{ gap: 'var(--s2)' }}>
              <strong className="small">v{v.version_no}</strong>
              <span className="xs muted num">{new Date(v.activated_at).toLocaleString()}</span>
            </span>
            <StepChain steps={v.spec} muted={i > 0} />
            <ul className="xs muted stack-2">
              {changes.map((c, j) => <li key={j}>· {c}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function diff(before: Step[], after: Step[]): string[] {
  const out: string[] = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const b = before[i]; const a = after[i];
    if (b && !a) { out.push(`Removed step ${b.step_no} “${b.name}”`); continue; }
    if (a && !b) { out.push(`Added step ${a.step_no} “${a.name}”`); continue; }
    if (!a || !b) continue;
    if (a.name !== b.name) out.push(`Step ${a.step_no} renamed “${b.name}” → “${a.name}”`);
    if (a.resolver !== b.resolver || a.role_code !== b.role_code) {
      out.push(`Step ${a.step_no} now routes to ${a.resolver === 'project_manager'
        ? 'the project manager' : a.role_code}`);
    }
    if (a.sla_hours !== b.sla_hours) {
      out.push(`Step ${a.step_no} SLA ${b.sla_hours ?? 'none'}h → ${a.sla_hours ?? 'none'}h`);
    }
  }
  return out.length ? out : ['No change to the steps'];
}

const BLANK_STEP: Step = { step_no: 1, name: '', resolver: 'project_manager' };

function Editor({ roles, definition, objectTypes, onDone, onCancel }: {
  roles: Role[];
  definition?: Definition;
  objectTypes?: { value: string; label: string }[];
  onDone: () => void; onCancel: () => void;
}) {
  const [objectType, setObjectType] = useState(objectTypes?.[0]?.value ?? '');
  const [name, setName] = useState(definition?.name ?? '');
  const [steps, setSteps] = useState<Step[]>(definition?.steps.length ? definition.steps : [BLANK_STEP]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const setStep = (i: number, patch: Partial<Step>) =>
    setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const clean = steps.map((s, i) => ({
      step_no: i + 1, name: s.name, resolver: s.resolver,
      ...(s.resolver === 'role_in_project' ? { role_code: s.role_code } : {}),
      ...(s.sla_hours ? { sla_hours: Number(s.sla_hours) } : {}),
    }));
    try {
      if (definition) {
        await api.post(`/approval-definitions/${definition.id}/versions`, { steps: clean });
      } else {
        await api.post('/approval-definitions', {
          objectType, name, scopeType: 'org', steps: clean,
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Publish failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack" onSubmit={submit} style={{ background: 'var(--bg)' }}>
      <h2 className="label">{definition ? `Publish v${(definition.current_version ?? 0) + 1}` : 'New workflow'}</h2>
      {error ? <ErrorBanner error={error} /> : null}

      {!definition ? (
        <div className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
          <label className="field"><span className="label">Applies to</span>
            <select className="select" value={objectType} onChange={(e) => setObjectType(e.target.value)}>
              {(objectTypes ?? []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="field grow"><span className="label">Name</span>
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="Daily report sign-off" />
          </label>
        </div>
      ) : null}

      {steps.map((s, i) => (
        <div key={i} className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
          <span className="label" style={{ minWidth: '3rem' }}>Step {i + 1}</span>
          <label className="field grow"><span className="label">Called</span>
            <input className="input" required minLength={2} value={s.name}
                   onChange={(e) => setStep(i, { name: e.target.value })}
                   placeholder="Site Engineer check" />
          </label>
          <label className="field"><span className="label">Decided by</span>
            <select className="select" value={s.resolver}
                    onChange={(e) => setStep(i, { resolver: e.target.value as Step['resolver'] })}>
              <option value="project_manager">The project manager</option>
              <option value="role_in_project">Anyone with a role</option>
            </select>
          </label>
          {s.resolver === 'role_in_project' ? (
            <label className="field"><span className="label">Which role</span>
              <select className="select" value={s.role_code ?? ''}
                      onChange={(e) => setStep(i, { role_code: e.target.value })} required>
                <option value="">— choose —</option>
                {roles.map((r) => <option key={r.id} value={r.code}>{r.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field"><span className="label">SLA hours</span>
            <input className="input" type="number" style={{ width: '6rem' }} min={1} max={720}
                   value={s.sla_hours ?? ''}
                   onChange={(e) => setStep(i, { sla_hours: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          {steps.length > 1 ? (
            <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}>Remove</button>
          ) : null}
        </div>
      ))}

      <div className="row-between wrap">
        <button type="button" className="btn btn-sm" disabled={steps.length >= 5}
                onClick={() => setSteps((ss) => [...ss, { ...BLANK_STEP, step_no: ss.length + 1 }])}>
          <Plus size={14} aria-hidden /> Add a step
        </button>
        <span className="row" style={{ gap: 'var(--s2)' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : <Save size={16} aria-hidden />}
            {definition ? 'Publish new version' : 'Create'}
          </button>
        </span>
      </div>
      <span className="xs muted">
        Past three steps this is a queue, not a control. The engine caps it at five.
      </span>
    </form>
  );
}
