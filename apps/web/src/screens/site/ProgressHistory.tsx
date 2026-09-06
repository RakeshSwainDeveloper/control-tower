import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { reference, recents, type LocationNode, type WorkItemRef } from '../../lib/reference.js';
import { Picker } from '../../components/Picker.js';
import { StatusChip } from '../../components/StatusChip.js';
import { EvidenceStrip, loadEvidence, type EvidenceAsset } from '../../components/EvidenceViewer.js';
import { EmptyState, Loading } from '../../components/Feedback.js';

/**
 * S-M14 — Progress history.
 *
 * "What has been recorded here, and what came of it." A supervisor standing in
 * a flat wants to know whether last week's plaster was accepted before they
 * plaster the next one — and if it was adjusted, by how much and why.
 *
 * So the reason is shown, not hidden behind a tap. A rejection a supervisor
 * never reads is a rejection that happens again.
 */
interface Entry {
  id: string; reported_qty: string; verified_qty: string | null;
  verification_status: string; verification_reason: string | null;
  unit: string; work_item: string; location: string;
  executed_on: string; reported_at: string;
  reported_by_name: string | null; reported_responsibility: string | null;
  verified_by_name: string | null; verified_responsibility: string | null;
}

const STATE_OF: Record<string, string> = {
  reported: 'submitted', verified: 'verified', adjusted: 'in_progress',
  rejected: 'rejected', superseded: 'cancelled',
};

export function ProgressHistory() {
  const { projectId } = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [locations, setLocations] = useState<LocationNode[]>([]);
  const [workItems, setWorkItems] = useState<WorkItemRef[]>([]);
  const [rows, setRows] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [assets, setAssets] = useState<EvidenceAsset[]>([]);
  const [picking, setPicking] = useState<'location' | 'work' | null>(null);
  const [loading, setLoading] = useState(true);

  const locationId = params.get('locationId');
  const workItemId = params.get('workItemId');

  useEffect(() => {
    if (!projectId) return;
    void Promise.all([reference.locations(projectId), reference.workItems(projectId)])
      .then(([l, w]) => { setLocations(l.data); setWorkItems(w.data); });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    void api.get<{ data: Entry[] }>(
      `/projects/${projectId}/progress${qs({
        limit: 100,
        locationId: locationId ?? undefined,
        workItemId: workItemId ?? undefined,
      })}`)
      .then((r) => setRows(r.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [projectId, locationId, workItemId]);

  const setFilter = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const open = async (e: Entry) => {
    if (expanded === e.id) { setExpanded(null); return; }
    setExpanded(e.id);
    setAssets(await loadEvidence('progress_entry', e.id).catch(() => []));
  };

  const location = locations.find((l) => l.id === locationId);
  const workItem = workItems.find((w) => w.id === workItemId);

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
              onClick={() => nav('/site')}>
        <ArrowLeft size={18} aria-hidden /> History
      </button>

      <div className="stack-2">
        <button type="button" className="input row-between" onClick={() => setPicking('location')}
                style={{ textAlign: 'left' }}>
          <span className={location ? '' : 'muted'}>
            {location ? location.display_path : 'Any location'}
          </span>
          <ChevronDown size={18} aria-hidden className="muted" />
        </button>
        <button type="button" className="input row-between" onClick={() => setPicking('work')}
                style={{ textAlign: 'left' }}>
          <span className={workItem ? '' : 'muted'}>
            {workItem ? workItem.description : 'Any work item'}
          </span>
          <ChevronDown size={18} aria-hidden className="muted" />
        </button>
        {locationId || workItemId ? (
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                  onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </button>
        ) : null}
      </div>

      {loading ? <Loading /> : rows.length === 0 ? (
        <EmptyState message="Nothing has been recorded here yet." />
      ) : (
        <ul className="stack-2">
          {rows.map((e) => (
            <li key={e.id} className="card">
              <button type="button" onClick={() => void open(e)} aria-expanded={expanded === e.id}
                      className="row" style={{ width: '100%', padding: 'var(--s3) var(--s4)',
                                               background: 'none', border: 0, textAlign: 'left',
                                               gap: 'var(--s3)' }}>
                <span className="grow stack-2" style={{ gap: 2, minWidth: 0 }}>
                  <strong className="truncate small">{e.work_item}</strong>
                  <span className="xs muted truncate">
                    {new Date(e.executed_on).toDateString()} · {e.location}
                  </span>
                </span>
                <span className="num small" style={{ flex: 'none', textAlign: 'right' }}>
                  <strong>{Number(e.reported_qty).toLocaleString()}</strong>
                  <span className="muted"> {e.unit}</span>
                  {e.verified_qty !== null
                    && Number(e.verified_qty) !== Number(e.reported_qty) ? (
                    <span className="xs" style={{ display: 'block', color: 'var(--st-progress)' }}>
                      confirmed {Number(e.verified_qty).toLocaleString()}
                    </span>
                  ) : null}
                </span>
                <StatusChip state={STATE_OF[e.verification_status] ?? 'draft'}
                            label={e.verification_status} />
              </button>

              {expanded === e.id ? (
                <div className="stack-2" style={{ padding: '0 var(--s4) var(--s4)' }}>
                  <span className="xs muted">
                    Recorded by {e.reported_by_name ?? 'unknown'}
                    {e.reported_responsibility ? ` as ${e.reported_responsibility}` : ''}
                    {' · '}{new Date(e.reported_at).toLocaleString()}
                  </span>
                  {/* The reason, in full. A rejection a supervisor never reads
                      is a rejection that happens again. */}
                  {e.verification_reason ? (
                    <div className={e.verification_status === 'rejected'
                      ? 'banner banner-bad' : 'banner banner-warn'}>
                      <div className="stack-2">
                        <strong className="small">
                          {e.verification_status === 'rejected' ? 'Rejected' : 'Adjusted'} by{' '}
                          {e.verified_by_name ?? 'unknown'}
                          {e.verified_responsibility ? ` as ${e.verified_responsibility}` : ''}
                        </strong>
                        <span className="small">{e.verification_reason}</span>
                      </div>
                    </div>
                  ) : null}
                  <EvidenceStrip assets={assets} emptyHint="No photographs attached" />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {picking === 'location' ? (
        <Picker title="Location"
          items={locations.filter((l) => !locations.some((c) => c.parent_id === l.id))
            .map((l) => ({ id: l.id, label: l.name, sub: l.display_path }))}
          recentIds={recents.locations()} value={locationId}
          onPick={(i) => { setFilter('locationId', i.id); setPicking(null); }}
          onClose={() => setPicking(null)} />
      ) : null}
      {picking === 'work' ? (
        <Picker title="Work item"
          items={workItems.map((w) => ({ id: w.id, label: w.description,
                                         sub: `${w.code} · ${w.unit_code ?? ''}` }))}
          recentIds={recents.workItems()} value={workItemId}
          onPick={(i) => { setFilter('workItemId', i.id); setPicking(null); }}
          onClose={() => setPicking(null)} />
      ) : null}
    </div>
  );
}
