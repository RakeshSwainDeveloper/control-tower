import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Camera, Check, ChevronDown, MapPin, Trash2 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { reference, recents, type LocationNode, type WorkItemRef } from '../../lib/reference.js';
import { Picker, type PickItem } from '../../components/Picker.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';
import { enqueue } from '../../lib/offline/outbox.js';
import { flush } from '../../lib/offline/sync-engine.js';
import * as evidence from '../../lib/offline/evidence.js';
import { api, ApiError } from '../../lib/api.js';

/**
 * S-M03 — Progress entry. The most important screen in the product.
 *
 * Everything downstream — verification, the daily report, the dashboard, the
 * reported-vs-verified gap — is a consequence of a supervisor opening this
 * screen tomorrow morning. Its gate is a MEASURED median under 45 seconds with
 * a target of 25, and if it misses, the release is blocked (MVP_SCREEN_LIST §7).
 *
 * Five fields. Four of them are one tap or pre-filled. One is typed, on a
 * numeric keypad, and it is a quantity.
 *
 *   LOCATION      recents first — the same four flats all week
 *   WORK ITEM     items active at this location first
 *   QUANTITY      the only typing. Large, right-aligned, numeric keypad
 *   EVIDENCE      camera opens directly, multi-shot
 *   CONTRACTOR    last used, pre-filled
 *
 * Two things this screen deliberately does NOT have:
 *
 *   · A percentage field. Percentage is DERIVED and displayed (FR-142).
 *     "80% done" is an opinion; "412 of 515 sqm" is a fact.
 *   · A save button that can fail. Submit writes to the outbox and returns.
 *     Whether there is signal is not the supervisor's problem.
 */
export function ProgressEntry() {
  const { projectId, responsibilityFor } = useSession();
  const nav = useNavigate();

  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRef[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);

  const [locationId, setLocationId] = useState<string | null>(null);
  const [workItemId, setWorkItemId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [contractor, setContractor] = useState(recents.contractor());
  const [note, setNote] = useState('');
  const [shots, setShots] = useState<evidence.PendingEvidence[]>([]);
  const [picker, setPicker] = useState<'location' | 'work' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [context, setContext] = useState<{ planned: number; done: number } | null>(null);
  const camera = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      const [l, w] = await Promise.all([
        reference.locations(projectId), reference.workItems(projectId),
      ]);
      setLocations(l.data); setWorkItems(w.data);
      setStale(l.stale || w.stale);
      // Pre-select the last location used. On a site that is right most
      // mornings, and being wrong costs one tap.
      const lastLoc = recents.locations()[0];
      if (lastLoc && l.data.some((x) => x.id === lastLoc)) setLocationId(lastLoc);
      setLoading(false);
    })();
  }, [projectId]);

  useEffect(() => evidence.subscribeEvidence(() => setShots(evidence.pending())), []);

  const location = locations.find((l) => l.id === locationId) ?? null;
  const workItem = workItems.find((w) => w.id === workItemId) ?? null;

  /** Planned / done, fetched only once both are chosen. Never blocks entry. */
  useEffect(() => {
    if (!projectId || !workItemId || !locationId) { setContext(null); return; }
    let cancelled = false;
    void api.get<{ data: { planned_qty: string; verified_qty: string }[] }>(
      `/projects/${projectId}/work-items/${workItemId}/allocations`,
    ).then((r) => {
      if (cancelled) return;
      const here = (r.data ?? []).find(() => true);
      const planned = Number(here?.planned_qty ?? workItem?.planned_qty ?? 0);
      setContext({ planned, done: Number(here?.verified_qty ?? 0) });
    }).catch(() => { if (!cancelled) setContext(null); });
    return () => { cancelled = true; };
  }, [projectId, workItemId, locationId, workItem?.planned_qty]);

  const n = Number(qty);
  const valid = !!locationId && !!workItemId && qty.trim() !== '' && n > 0;

  const submit = async () => {
    if (!valid || !projectId) return;
    setBusy(true); setError(null);
    try {
      // 1. Queue the entry. This cannot fail for want of a network — the whole
      //    design of Phase 4 exists so this line is true.
      const clientUuid = await enqueue({
        entity: 'progress_entry',
        payload: {
          project_id: projectId,
          work_item_id: workItemId,
          location_id: locationId,
          reported_qty: qty,
          executed_on: new Date().toISOString().slice(0, 10),
          ...(contractor ? { contractor_label: contractor } : {}),
          ...(note ? { note } : {}),
        },
        label: `${workItem?.description ?? 'Work'} · ${qty} ${workItem?.unit_code ?? ''} · ${location?.name ?? ''}`,
        projectId,
      });

      // 2. Photos upload themselves, and attach on arrival. Failures stay on
      //    the device; they never block the entry that is already recorded.
      void evidence.uploadAll(shots.map((s) => s.id));

      recents.rememberLocation(locationId!);
      recents.rememberWorkItem(workItemId!);
      if (contractor) recents.rememberContractor(contractor);

      void flush();
      setDone(clientUuid);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not save', status: 0 }));
    } finally { setBusy(false); }
  };

  const addShots = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      await evidence.capture(f, {
        kind: 'photo', purpose: 'progress',
        ...(projectId ? { projectId } : {}),
        ...(locationId ? { locationId } : {}),
      });
    }
  };

  if (loading) return <Loading label="Loading your site" />;

  if (done) {
    return (
      <div className="stack" style={{ gap: 'var(--s5)', paddingTop: 'var(--s6)' }}>
        <div className="banner banner-ok">
          <Check size={20} aria-hidden style={{ flex: 'none' }} />
          <div className="stack-2">
            <strong>Recorded</strong>
            <span className="small">
              {qty} {workItem?.unit_code} of {workItem?.description} at {location?.name}.
              It will reach the office by itself.
            </span>
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={() => {
          // The next entry is usually the same work item at the next flat, so
          // keep everything except the quantity and the photos.
          setDone(null); setQty(''); setNote('');
          for (const s of shots) evidence.forget(s.id);
        }}>
          Record another
        </button>
        <button type="button" className="btn btn-block" onClick={() => nav('/site')}>Done for now</button>
      </div>
    );
  }

  const pct = context && context.planned > 0
    ? { before: (context.done / context.planned) * 100,
        after: ((context.done + (n || 0)) / context.planned) * 100 }
    : null;

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <button type="button" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}
                onClick={() => nav('/site')}>
          <ArrowLeft size={18} aria-hidden /> Progress
        </button>
      </div>

      {error ? <ErrorBanner error={error} /> : null}
      {stale ? (
        <p className="xs muted">Using the lists saved on this device — you appear to be offline.</p>
      ) : null}

      <Field label="Location">
        <button type="button" className="input row-between" onClick={() => setPicker('location')}
                style={{ textAlign: 'left' }}>
          <span className={location ? '' : 'muted'}>
            {location ? location.display_path : 'Choose a location'}
          </span>
          <ChevronDown size={18} aria-hidden className="muted" />
        </button>
      </Field>

      <Field label="Work item">
        <button type="button" className="input row-between" onClick={() => setPicker('work')}
                style={{ textAlign: 'left' }} disabled={!locationId}>
          <span className={workItem ? '' : 'muted'}>
            {workItem ? workItem.description : 'Choose the work'}
          </span>
          <span className="row" style={{ gap: 'var(--s2)' }}>
            {workItem?.unit_code ? <span className="muted small">{workItem.unit_code}</span> : null}
            <ChevronDown size={18} aria-hidden className="muted" />
          </span>
        </button>
      </Field>

      <Field label="Quantity today">
        <div className="row" style={{ gap: 'var(--s2)' }}>
          {/* inputMode="decimal" is what raises the NUMERIC keypad on Android.
              A supervisor should never see a QWERTY keyboard to type "12". */}
          <input
            className="input input-qty grow" type="text" inputMode="decimal"
            pattern="[0-9]*[.,]?[0-9]*" value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
            aria-label="Quantity today" placeholder="0"
          />
          <span className="muted" style={{ fontSize: 'var(--text-lg)', minWidth: '3rem' }}>
            {workItem?.unit_code ?? ''}
          </span>
        </div>
        {pct ? (
          <>
            <p className="small muted num">
              Planned {context!.planned.toLocaleString()} · done {context!.done.toLocaleString()}
              {n > 0 ? ` → ${(context!.done + n).toLocaleString()}` : ''}
            </p>
            {/* DISPLAYED, never typed. FR-142. */}
            <div className="bar" role="img"
                 aria-label={`${Math.round(pct.before)} percent complete, ${Math.round(pct.after)} percent after this entry`}>
              <span className="bar-done" style={{ width: `${Math.min(100, pct.before)}%` }} />
              <span className="bar-pending"
                    style={{ width: `${Math.max(0, Math.min(100 - pct.before, pct.after - pct.before))}%` }} />
            </div>
            <p className="xs muted num">
              {Math.round(pct.before)}%{n > 0 ? ` → ${Math.round(pct.after)}%` : ''}
              {pct.after > 100 ? ' · over the planned quantity — you will be asked why' : ''}
            </p>
          </>
        ) : null}
      </Field>

      <Field label="Evidence">
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
              {s.state === 'failed' ? (
                <span className="xs" style={{ position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'var(--destructive)', color: '#fff', textAlign: 'center' }}>
                  will retry
                </span>
              ) : null}
            </div>
          ))}
          <button type="button" className="thumb-add" onClick={() => camera.current?.click()}>
            <Camera size={22} aria-hidden />
            ADD
          </button>
        </div>
        {/* capture="environment" opens the rear camera directly rather than a
            file chooser. multiple allows several shots without re-entering. */}
        <input ref={camera} type="file" accept="image/*" capture="environment" multiple
               className="sr-only" onChange={(e) => { void addShots(e.target.files); e.target.value = ''; }} />
        <p className="xs muted row" style={{ gap: 'var(--s2)' }}>
          <MapPin size={12} aria-hidden />
          {shots.length === 0
            ? 'Time and location are recorded with each photo'
            : shots[0]?.gps
              ? `GPS recorded · as ${responsibilityFor('field.progress.create') ?? 'you'}`
              : shots[0]?.gpsUnavailableReason ?? 'Recording location…'}
        </p>
      </Field>

      <Field label="Contractor">
        <input className="input" value={contractor} onChange={(e) => setContractor(e.target.value)}
               placeholder="Optional" aria-label="Contractor" />
      </Field>

      <Field label="Note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="Optional" aria-label="Note" />
      </Field>

      <button type="button" className="btn btn-primary btn-block" disabled={!valid || busy}
              onClick={() => void submit()}
              style={{ minHeight: '3.5rem', fontSize: 'var(--text-lg)', position: 'sticky',
                       bottom: 'var(--s4)' }}>
        {busy ? <span className="spinner" aria-hidden /> : null} SUBMIT
      </button>

      {picker === 'location' ? (
        <Picker
          title="Location" stale={stale}
          items={locationPickItems(locations)}
          recentIds={recents.locations()}
          value={locationId}
          onPick={(i: PickItem) => { setLocationId(i.id); setPicker(null); }}
          onClose={() => setPicker(null)}
          emptyHint="No locations have been set up for this project yet."
        />
      ) : null}

      {picker === 'work' ? (
        <Picker
          title="Work item" stale={stale}
          items={workItems.map((w) => ({
            id: w.id, label: w.description, sub: `${w.code} · ${w.unit_code ?? ''}`,
          }))}
          recentIds={recents.workItems()}
          value={workItemId}
          onPick={(i) => { setWorkItemId(i.id); setPicker(null); }}
          onClose={() => setPicker(null)}
          emptyHint="No work items have been imported for this project yet."
        />
      ) : null}
    </div>
  );
}

/**
 * Only leaves are offered.
 *
 * Recording 12 sqm of plaster against "Floor 5" rather than "Flat 502 ›
 * Bathroom" makes the number unusable for verification, and a picker that
 * allows it will collect them.
 */
function locationPickItems(locations: LocationNode[]): PickItem[] {
  const parents = new Set(locations.map((l) => l.parent_id).filter(Boolean) as string[]);
  return locations
    .filter((l) => !parents.has(l.id))
    .map((l) => ({ id: l.id, label: l.name, sub: l.display_path }));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}
