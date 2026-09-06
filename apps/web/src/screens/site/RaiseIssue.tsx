import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Camera, Check, ChevronDown, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { reference, recents, type LocationNode } from '../../lib/reference.js';
import { Picker } from '../../components/Picker.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';
import { enqueue } from '../../lib/offline/outbox.js';
import { flush } from '../../lib/offline/sync-engine.js';
import * as evidence from '../../lib/offline/evidence.js';

/**
 * S-M10 — Raise an issue. Target: 45 seconds.
 *
 * A form that asks for more than this at the moment somebody notices a problem
 * is a form that produces no issues. Category and severity are chips; location
 * is one tap from recents; the camera opens directly. Title is the only typing,
 * and everything else — assignee, due date, description — is optional and
 * below the fold.
 *
 * Offline-capable, and only for CREATE. Resolving, verifying and closing all
 * depend on server state the phone cannot see, and a device deciding those
 * from a stale copy is how a defect gets signed off by whoever caused it.
 */
interface Category { id: string; code: string; name: string }

const SEVERITIES = [
  { code: 'low', label: 'Low' },
  { code: 'medium', label: 'Medium' },
  { code: 'high', label: 'High' },
  { code: 'critical', label: 'Critical' },
] as const;

export function RaiseIssue() {
  const { projectId, responsibilityFor } = useSession();
  const nav = useNavigate();

  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState<string>('medium');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [members, setMembers] = useState<{ user_id: string; name: string }[]>([]);
  const [shots, setShots] = useState<evidence.PendingEvidence[]>([]);
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const camera = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      const [l, cats, mem] = await Promise.all([
        reference.locations(projectId),
        api.get<{ data: Category[] }>('/master-data?kind=issue_category')
          .then((r) => r.data ?? []).catch(() => [] as Category[]),
        api.get<{ data: { user_id: string; name: string }[] }>(`/projects/${projectId}/members`)
          .then((r) => r.data ?? []).catch(() => []),
      ]);
      setLocations(l.data); setStale(l.stale);
      setCategories(cats); setMembers(mem);
      const last = recents.locations()[0];
      if (last && l.data.some((x) => x.id === last)) setLocationId(last);
      setLoading(false);
    })();
  }, [projectId]);

  useEffect(() => evidence.subscribeEvidence(() => setShots(evidence.pending())), []);

  const location = locations.find((l) => l.id === locationId) ?? null;
  const valid = title.trim().length >= 3 && !!severity;

  const submit = async () => {
    if (!valid || !projectId) return;
    setBusy(true); setError(null);
    try {
      const clientUuid = await enqueue({
        entity: 'issue',
        payload: {
          project_id: projectId,
          title: title.trim(),
          severity,
          ...(category ? { category_code: category } : {}),
          ...(description ? { description } : {}),
          ...(locationId ? { location_id: locationId } : {}),
          ...(assigneeId ? { assignee_user_id: assigneeId } : {}),
          ...(dueDate ? { due_date: dueDate } : {}),
        },
        label: `${SEVERITIES.find((s) => s.code === severity)?.label ?? ''}: ${title.trim()}`,
        projectId,
      });
      void evidence.uploadAll(shots.map((s) => s.id));
      if (locationId) recents.rememberLocation(locationId);
      void flush();
      setDone(true);
      void clientUuid;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not save', status: 0 }));
    } finally { setBusy(false); }
  };

  const addShots = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      await evidence.capture(f, {
        kind: 'photo', purpose: 'issue',
        ...(projectId ? { projectId } : {}),
        ...(locationId ? { locationId } : {}),
      });
    }
  };

  if (loading) return <Loading label="Loading" />;

  if (done) {
    return (
      <div className="stack" style={{ gap: 'var(--s5)', paddingTop: 'var(--s6)' }}>
        <div className="banner banner-ok">
          <Check size={20} aria-hidden style={{ flex: 'none' }} />
          <div className="stack-2">
            <strong>Raised</strong>
            <span className="small">
              “{title.trim()}” — it will reach the office by itself, even from here.
            </span>
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={() => {
          setDone(false); setTitle(''); setDescription('');
          for (const s of shots) evidence.forget(s.id);
        }}>Raise another</button>
        <button type="button" className="btn btn-block" onClick={() => nav('/site/issues')}>
          See the issue list
        </button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
              onClick={() => nav(-1)}>
        <ArrowLeft size={18} aria-hidden /> Raise an issue
      </button>

      {error ? <ErrorBanner error={error} /> : null}

      <label className="field">
        <span className="label">What is wrong</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
               autoFocus aria-label="What is wrong"
               placeholder="Honeycombing on column C4" />
      </label>

      <div className="field">
        <span className="label">Category</span>
        {/* Chips, not a dropdown. Six options, one tap, readable in sunlight. */}
        <div className="row wrap" style={{ gap: 'var(--s2)' }}>
          {categories.map((c) => (
            <button key={c.id} type="button" className="chip-select"
                    aria-pressed={category === c.code}
                    onClick={() => setCategory(category === c.code ? '' : c.code)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="label">How serious</span>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          {SEVERITIES.map((s) => (
            <button key={s.code} type="button" className="chip-select grow"
                    aria-pressed={severity === s.code}
                    onClick={() => setSeverity(s.code)}
                    style={severity === s.code
                      ? { background: `var(--sev-${s.code})`, borderColor: `var(--sev-${s.code})`,
                          color: '#fff' }
                      : undefined}>
              {s.label}
            </button>
          ))}
        </div>
        {severity === 'high' || severity === 'critical' ? (
          /* Said before it happens, not discovered at closing time. */
          <span className="xs muted">
            High and critical issues need an approval to close, as well as a check.
          </span>
        ) : null}
      </div>

      <div className="field">
        <span className="label">Where</span>
        <button type="button" className="input row-between" onClick={() => setPicking(true)}
                style={{ textAlign: 'left' }}>
          <span className={location ? '' : 'muted'}>
            {location ? location.display_path : 'Choose a location (optional)'}
          </span>
          <ChevronDown size={18} aria-hidden className="muted" />
        </button>
      </div>

      <div className="field">
        <span className="label">Photograph</span>
        <div className="thumb-grid">
          {shots.map((s) => (
            <div key={s.id} className="thumb">
              {s.previewUrl ? <img src={s.previewUrl} alt="" /> : null}
              <button type="button" onClick={() => evidence.forget(s.id)}
                      aria-label="Remove this photo"
                      style={{ position: 'absolute', top: 2, right: 2, border: 0,
                               borderRadius: '50%', width: 26, height: 26,
                               background: 'rgb(2 6 23 / 0.6)', color: '#fff',
                               display: 'grid', placeItems: 'center' }}>
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          ))}
          <button type="button" className="thumb-add" onClick={() => camera.current?.click()}>
            <Camera size={22} aria-hidden /> ADD
          </button>
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" multiple
               className="sr-only"
               onChange={(e) => { void addShots(e.target.files); e.target.value = ''; }} />
      </div>

      {/* Everything below here is optional and folded away. The 45 seconds are
          spent above this line. */}
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
              onClick={() => setMore((m) => !m)} aria-expanded={more}>
        {more ? 'Fewer details' : 'Assign it, or add more detail'}
      </button>

      {more ? (
        <>
          <label className="field">
            <span className="label">Who should fix it</span>
            <select className="select" value={assigneeId} aria-label="Who should fix it"
                    onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Nobody yet</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">By when</span>
            <input className="input" type="date" value={dueDate} aria-label="By when"
                   onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="label">More detail</span>
            <textarea className="textarea" rows={3} value={description} aria-label="More detail"
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Visible voids around the base, roughly 300mm up" />
          </label>
        </>
      ) : null}

      <button type="button" className="btn btn-primary btn-block" disabled={!valid || busy}
              onClick={() => void submit()}
              style={{ minHeight: '3.5rem', fontSize: 'var(--text-lg)',
                       position: 'sticky', bottom: 'var(--s4)' }}>
        {busy ? <span className="spinner" aria-hidden /> : null} RAISE IT
      </button>
      <p className="xs muted" style={{ textAlign: 'center' }}>
        Recorded as {responsibilityFor('issue.issue.create') ?? 'you'}
        {stale ? ' · saved on this device until you have signal' : ''}
      </p>

      {picking ? (
        <Picker
          title="Location" stale={stale}
          items={locations.filter((l) => !locations.some((c) => c.parent_id === l.id))
            .map((l) => ({ id: l.id, label: l.name, sub: l.display_path }))}
          recentIds={recents.locations()}
          value={locationId}
          onPick={(i) => { setLocationId(i.id); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
