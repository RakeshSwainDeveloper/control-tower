import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Clock, Search, X } from 'lucide-react';

/**
 * The picker behind S-M04 (location) and S-M05 (work item).
 *
 * One component, because the interaction is identical and the screen list's
 * requirement for both is the same sentence: **recents first, then the list,
 * never a blank search box.** A supervisor works in the same four flats all
 * week; making them search for Flat 502 every morning is the difference between
 * a 25-second entry and a 60-second one.
 *
 * Search is present but secondary — it earns its place on a 168-location tree,
 * and it is never the first thing offered.
 */
export interface PickItem {
  id: string;
  label: string;
  sub?: string;
  /** Group heading, e.g. the parent flat. */
  group?: string;
}

export function Picker({
  title, items, recentIds, value, onPick, onClose, emptyHint, stale,
}: {
  title: string;
  items: PickItem[];
  recentIds: string[];
  value?: string | null;
  onPick: (item: PickItem) => void;
  onClose: () => void;
  emptyHint?: string;
  stale?: boolean;
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const { recent, rest } = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const r = recentIds.map((id) => byId.get(id)).filter((x): x is PickItem => !!x);
    const seen = new Set(r.map((x) => x.id));
    return { recent: r, rest: items.filter((i) => !seen.has(i.id)) };
  }, [items, recentIds]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? items.filter((i) =>
        i.label.toLowerCase().includes(needle) ||
        (i.sub ?? '').toLowerCase().includes(needle))
    : null;

  const Row = ({ item }: { item: PickItem }) => (
    <li>
      <button type="button" className="list-row" onClick={() => onPick(item)}
              aria-pressed={value === item.id}>
        <span className="grow stack-2" style={{ gap: 0, minWidth: 0 }}>
          <strong className="truncate">{item.label}</strong>
          {item.sub ? <span className="xs muted truncate">{item.sub}</span> : null}
        </span>
        {value === item.id
          ? <Check size={18} aria-hidden style={{ color: 'var(--st-verified)' }} />
          : <ChevronRight size={18} aria-hidden className="muted" />}
      </button>
    </li>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="site"
         style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'var(--bg)',
                  display: 'flex', flexDirection: 'column' }}>
      <header className="row-between" style={{
        padding: 'var(--s3) var(--s4)', background: 'var(--card)',
        borderBottom: '1px solid var(--border)',
        paddingTop: 'max(var(--s3), env(safe-area-inset-top))',
      }}>
        <strong>{title}</strong>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          <X size={20} aria-hidden /><span className="sr-only">Close</span>
        </button>
      </header>

      <div style={{ padding: 'var(--s3) var(--s4)' }}>
        <label className="row" style={{ gap: 'var(--s2)' }}>
          <Search size={18} aria-hidden className="muted" />
          <span className="sr-only">Search {title.toLowerCase()}</span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder={`Search ${items.length} — or just pick below`} />
        </label>
        {stale ? (
          <p className="xs muted" style={{ marginTop: 'var(--s2)' }}>
            Showing the list saved on this device. It will refresh when you have signal.
          </p>
        ) : null}
      </div>

      <div className="grow" style={{ overflowY: 'auto', padding: '0 var(--s4) var(--s8)' }}>
        {items.length === 0 ? (
          <p className="muted small" style={{ padding: 'var(--s5) 0' }}>
            {emptyHint ?? 'Nothing to choose from yet.'}
          </p>
        ) : filtered ? (
          filtered.length === 0
            ? <p className="muted small" style={{ padding: 'var(--s5) 0' }}>Nothing matches “{q}”.</p>
            : <ul className="stack-2">{filtered.map((i) => <Row key={i.id} item={i} />)}</ul>
        ) : (
          <>
            {recent.length > 0 ? (
              <section className="stack-2" style={{ marginBottom: 'var(--s5)' }}>
                <h2 className="label row" style={{ gap: 'var(--s2)' }}>
                  <Clock size={13} aria-hidden /> Recent
                </h2>
                <ul className="stack-2">{recent.map((i) => <Row key={i.id} item={i} />)}</ul>
              </section>
            ) : null}
            <section className="stack-2">
              {recent.length > 0 ? <h2 className="label">Everything else</h2> : null}
              <ul className="stack-2">{rest.map((i) => <Row key={i.id} item={i} />)}</ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
