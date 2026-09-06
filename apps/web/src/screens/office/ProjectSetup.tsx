import { useEffect, useState, type FormEvent } from 'react';
import { FolderTree, Layers, ListPlus, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { EmptyState, ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-W08 — Project setup.
 *
 * Three jobs, in the order a project actually gets set up: the project's own
 * details, then the location tree, then the work items.
 *
 * The location tree is built by PATTERN, not one node at a time. A residential
 * tower is 8 floors × 4 flats × 4 rooms = 168 locations; creating those by hand
 * is a day's work and the reason location trees end up as a single node called
 * "Site". The pattern builder makes it a minute.
 *
 * Work items arrive as a spreadsheet, because they always do. Map columns,
 * preview what will be created, then confirm — never a silent import.
 */
interface Location {
  id: string; parent_id: string | null; code: string; name: string;
  level_name: string | null; display_path: string; depth: number;
}
interface WorkItem {
  id: string; code: string; description: string; unit_code?: string; planned_qty: string;
}

export function ProjectSetup() {
  const { projectId, projects } = useSession();
  const [tab, setTab] = useState<'locations' | 'work' | 'team'>('locations');
  const project = projects.find((p) => p.id === projectId);

  if (!projectId) return <EmptyState message="Select a project first." />;

  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="stack-2">
        <h1>Project setup</h1>
        <p className="small muted">{project?.code} — {project?.name}</p>
      </div>

      <div className="row" style={{ gap: 'var(--s1)' }} role="tablist">
        {([['locations', 'Locations', FolderTree],
           ['work', 'Work items', Layers],
           ['team', 'Team', ListPlus]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
                  className={tab === id ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                  onClick={() => setTab(id)}>
            <Icon size={15} aria-hidden /> {label}
          </button>
        ))}
      </div>

      {tab === 'locations' ? <Locations projectId={projectId} /> : null}
      {tab === 'work' ? <WorkItems projectId={projectId} /> : null}
      {tab === 'team' ? <Team projectId={projectId} /> : null}
    </div>
  );
}

function Locations({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [building, setBuilding] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get<{ data: Location[] }>(`/projects/${projectId}/locations`);
      setRows(r.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [projectId]);

  const byDepth = rows.reduce<Record<number, number>>((acc, r) => {
    acc[r.depth] = (acc[r.depth] ?? 0) + 1; return acc;
  }, {});

  return (
    <div className="stack">
      <div className="row-between wrap">
        <span className="small muted">
          {rows.length} location{rows.length === 1 ? '' : 's'}
          {Object.keys(byDepth).length > 0
            ? ` · ${Object.entries(byDepth).map(([d, n]) => `level ${d}: ${n}`).join(' · ')}`
            : ''}
        </span>
        <button type="button" className="btn btn-primary" onClick={() => setBuilding((b) => !b)}>
          <Layers size={16} aria-hidden /> Build from a pattern
        </button>
      </div>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}
      {building ? <PatternBuilder projectId={projectId}
                                  onDone={() => { setBuilding(false); void load(); }} /> : null}

      {loading ? <Loading /> : rows.length === 0 ? (
        <EmptyState message="No locations yet. Build the tree from a pattern — it takes a minute." />
      ) : (
        <div className="card scroll-x" style={{ maxHeight: '32rem', overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>Location</th><th>Code</th><th>Level</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  {/* Indent by depth: the tree shape is the information. */}
                  <td style={{ paddingLeft: `calc(var(--s3) + ${(l.depth - 1) * 1.25}rem)` }}>
                    {l.name}
                  </td>
                  <td><code className="xs">{l.code}</code></td>
                  <td className="small muted">{l.level_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface Level {
  levelName: string;
  mode: 'range' | 'items';
  from: number; to: number; codeTemplate: string; nameTemplate: string; pad: number;
  items: string;
}

const BLANK: Level = {
  levelName: '', mode: 'range', from: 1, to: 8,
  codeTemplate: 'L{n}', nameTemplate: 'Floor {n}', pad: 0, items: '',
};

function PatternBuilder({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [levels, setLevels] = useState<Level[]>([
    { ...BLANK, levelName: 'Floor' },
    { ...BLANK, levelName: 'Flat', from: 1, to: 4, codeTemplate: 'F{n}', nameTemplate: 'Flat {n}' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // The count before you commit. 8 × 4 × 4 is 168 rows, and someone should see
  // that number before creating them, not after.
  const total = levels.reduce((n, l) => n * (
    l.mode === 'range' ? Math.max(0, l.to - l.from + 1)
                       : l.items.split(',').filter((s) => s.trim()).length
  ), 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ created: number }>(`/projects/${projectId}/locations/bulk`, {
        levels: levels.map((l) => ({
          levelName: l.levelName,
          ...(l.mode === 'range'
            ? { range: { from: l.from, to: l.to, codeTemplate: l.codeTemplate,
                         nameTemplate: l.nameTemplate, pad: l.pad } }
            : { items: l.items.split(',').map((s) => s.trim()).filter(Boolean)
                  .map((s) => ({ code: s, name: s })) }),
        })),
      });
      setResult(`Created ${r.created} locations.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Build failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <form className="card card-p stack" onSubmit={submit}>
      <h2 className="label">Build the tree</h2>
      {error ? <ErrorBanner error={error} /> : null}
      {result ? <div className="banner banner-ok">{result}</div> : null}

      {levels.map((l, i) => (
        <div key={i} className="row wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
          <label className="field"><span className="label">Level {i + 1} name</span>
            <input className="input" style={{ width: '8rem' }} value={l.levelName} required
                   onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                     j === i ? { ...x, levelName: e.target.value } : x))} />
          </label>
          <label className="field"><span className="label">From</span>
            <select className="select" style={{ width: '7rem' }} value={l.mode}
                    onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                      j === i ? { ...x, mode: e.target.value as 'range' } : x))}>
              <option value="range">A range</option>
              <option value="items">A list</option>
            </select>
          </label>
          {l.mode === 'range' ? (
            <>
              <label className="field"><span className="label">Numbers</span>
                <span className="row" style={{ gap: 'var(--s2)' }}>
                  <input className="input" type="number" style={{ width: '4.5rem' }} value={l.from}
                         onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                           j === i ? { ...x, from: Number(e.target.value) } : x))} />
                  <span className="muted">to</span>
                  <input className="input" type="number" style={{ width: '4.5rem' }} value={l.to}
                         onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                           j === i ? { ...x, to: Number(e.target.value) } : x))} />
                </span>
              </label>
              <label className="field"><span className="label">Code pattern</span>
                <input className="input" style={{ width: '7rem' }} value={l.codeTemplate}
                       onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                         j === i ? { ...x, codeTemplate: e.target.value } : x))} />
              </label>
              <label className="field"><span className="label">Name pattern</span>
                <input className="input" style={{ width: '9rem' }} value={l.nameTemplate}
                       onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                         j === i ? { ...x, nameTemplate: e.target.value } : x))} />
              </label>
            </>
          ) : (
            <label className="field grow"><span className="label">Comma-separated</span>
              <input className="input" value={l.items} placeholder="Living, Bedroom, Kitchen, Bathroom"
                     onChange={(e) => setLevels((ls) => ls.map((x, j) =>
                       j === i ? { ...x, items: e.target.value } : x))} />
            </label>
          )}
          {levels.length > 1 ? (
            <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
          ) : null}
        </div>
      ))}

      <div className="row-between wrap">
        <button type="button" className="btn btn-sm" disabled={levels.length >= 5}
                onClick={() => setLevels((ls) => [...ls, { ...BLANK, levelName: '' }])}>
          Add a level
        </button>
        <span className="row" style={{ gap: 'var(--s3)' }}>
          <strong className="num">{total.toLocaleString()} locations</strong>
          <button className="btn btn-primary" type="submit" disabled={busy || total === 0 || total > 5000}>
            {busy ? <span className="spinner" aria-hidden /> : null} Create them
          </button>
        </span>
      </div>
      <span className="xs muted">
        {'{n}'} is replaced by the number. Levels nest: every item at level 1 gets
        every item at level 2 beneath it.
      </span>
    </form>
  );
}

function WorkItems({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: WorkItem[] }>(`/projects/${projectId}/work-items?limit=500`);
      setRows(r.data ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [projectId]);

  return (
    <div className="stack">
      <div className="row-between wrap">
        <span className="small muted">{rows.length} work item{rows.length === 1 ? '' : 's'}</span>
        <button type="button" className="btn btn-primary" onClick={() => setImporting((v) => !v)}>
          <Upload size={16} aria-hidden /> Import from a spreadsheet
        </button>
      </div>
      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}
      {importing ? <ImportWizard projectId={projectId}
                                 onDone={() => { setImporting(false); void load(); }} /> : null}
      {loading ? <Loading /> : rows.length === 0 ? (
        <EmptyState message="No work items yet." />
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr><th>Code</th><th>Description</th><th>Unit</th><th className="n">Planned</th></tr></thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td><code className="xs">{w.code}</code></td>
                  <td>{w.description}</td>
                  <td className="small muted">{w.unit_code ?? '—'}</td>
                  <td className="n num">{Number(w.planned_qty).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const FIELDS = ['code', 'description', 'unitCode', 'plannedQty'] as const;

function ImportWizard({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ ok: number; errors: { row: number; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /** Paste, not upload: a construction PM has the sheet open, not saved. */
  const parse = (text: string) => {
    const lines = text.trim().split('\n').filter((l) => l.trim());
    if (lines.length < 2) { setHeaders([]); setRows([]); return; }
    const sep = lines[0]!.includes('\t') ? '\t' : ',';
    const head = lines[0]!.split(sep).map((h) => h.trim());
    setHeaders(head);
    setRows(lines.slice(1).map((l) => {
      const cells = l.split(sep);
      return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
    }));
    // Guess the mapping from the header names. A guess the user can see and
    // correct beats a mandatory mapping step they have to do every time.
    const guess: Record<string, string> = {};
    for (const f of FIELDS) {
      const hit = head.find((h) => h.toLowerCase().replace(/[^a-z]/g, '')
        .includes(f.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4)));
      if (hit) guess[f] = hit;
    }
    setMap(guess);
  };

  const runPreview = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ job_id: string; ok: number; errors: { row: number; message: string }[] }>(
        `/projects/${projectId}/work-items/import`,
        { columnMap: map, rows },
      );
      setJobId(r.job_id);
      setPreview({ ok: r.ok, errors: r.errors ?? [] });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Preview failed', status: 0 }));
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      await api.post(`/projects/${projectId}/work-items/import/${jobId}/confirm`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Import failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <div className="card card-p stack">
      <h2 className="label">Import work items · map → preview → confirm</h2>
      {error ? <ErrorBanner error={error} /> : null}

      <label className="field">
        <span className="label">Paste the sheet, including its header row</span>
        <textarea className="textarea" rows={6} value={raw}
                  onChange={(e) => { setRaw(e.target.value); parse(e.target.value); }}
                  placeholder={'Code\tDescription\tUnit\tQty\nWI-PLI\tWall plaster\tsqm\t5400'} />
      </label>

      {headers.length > 0 ? (
        <>
          <div className="row wrap" style={{ gap: 'var(--s3)' }}>
            {FIELDS.map((f) => (
              <label key={f} className="field"><span className="label">{f}</span>
                <select className="select" value={map[f] ?? ''}
                        onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value }))}>
                  <option value="">— not mapped —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="row-between">
            <span className="small muted">{rows.length} rows read</span>
            <button type="button" className="btn" onClick={() => void runPreview()}
                    disabled={busy || !map['code'] || !map['description']}>
              Preview
            </button>
          </div>
        </>
      ) : null}

      {preview ? (
        <div className="stack-2">
          <div className={preview.errors.length ? 'banner banner-warn' : 'banner banner-ok'}>
            {preview.ok} row{preview.ok === 1 ? '' : 's'} will be created
            {preview.errors.length ? `, ${preview.errors.length} will be skipped` : ''}.
          </div>
          {preview.errors.length ? (
            <ul className="stack-2">
              {preview.errors.slice(0, 10).map((e) => (
                <li key={e.row} className="small">Row {e.row}: {e.message}</li>
              ))}
            </ul>
          ) : null}
          {/* Nothing is written until this button. An import that applies on
              upload is an import nobody can check. */}
          <button type="button" className="btn btn-primary" onClick={() => void confirm()}
                  disabled={busy || preview.ok === 0}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            Confirm and create {preview.ok}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Team({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<{ user_id: string; name: string; responsibility_label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api.get<{ data: typeof members }>(`/projects/${projectId}/members`)
      .then((r) => setMembers(r.data ?? []))
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <Loading />;
  if (members.length === 0) return <EmptyState message="Nobody is granted access to this project yet." />;
  return (
    <ul className="stack-2">
      {members.map((m) => (
        <li key={`${m.user_id}-${m.responsibility_label}`} className="card card-p row-between"
            style={{ padding: 'var(--s3) var(--s4)' }}>
          <strong className="small">{m.name}</strong>
          <span className="chip" style={{ background: 'var(--accent-weak)', color: 'var(--accent)' }}>
            {m.responsibility_label}
          </span>
        </li>
      ))}
    </ul>
  );
}
