import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * The standard record page: identity + actions · details · evidence · timeline.
 *
 * Every record in the product has the same four bands in the same order, so a
 * project manager who has learned one record page has learned all of them. The
 * actions sit at the top next to the identity because the question a person
 * arrives with is almost always "what do I do about this".
 */
export function RecordPage({
  title, subtitle, chips, actions, details, evidence, timeline, back,
}: {
  title: string;
  subtitle?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  details: ReactNode;
  evidence?: ReactNode;
  timeline?: ReactNode;
  back?: string;
}) {
  const nav = useNavigate();
  return (
    <div className="stack" style={{ gap: 'var(--s6)' }}>
      <div className="stack-2">
        {back !== undefined ? (
          <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}
                  onClick={() => nav(back || -1 as never)}>
            <ArrowLeft size={16} aria-hidden /> Back
          </button>
        ) : null}
        <div className="row-between wrap">
          <div className="stack-2 grow">
            <div className="row wrap" style={{ gap: 'var(--s2)' }}>
              <h1>{title}</h1>
              {chips}
            </div>
            {subtitle ? <p className="muted small">{subtitle}</p> : null}
          </div>
          {actions ? <div className="row wrap" style={{ gap: 'var(--s2)' }}>{actions}</div> : null}
        </div>
      </div>

      <section className="card card-p stack" aria-label="Details">{details}</section>

      {evidence ? (
        <section className="stack" aria-label="Evidence">
          <h2 className="label">Evidence</h2>
          {evidence}
        </section>
      ) : null}

      {timeline ? (
        <section className="stack" aria-label="Timeline">
          <h2 className="label">Timeline</h2>
          {timeline}
        </section>
      ) : null}
    </div>
  );
}

/** A definition list that collapses to one column on a phone. */
export function Details({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl style={{
      display: 'grid', gridTemplateColumns: 'minmax(8rem, 12rem) 1fr',
      gap: 'var(--s3) var(--s5)', margin: 0,
    }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: 'contents' }}>
          <dt className="muted small">{i.label}</dt>
          <dd style={{ margin: 0 }}>{i.value ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TimelineEvent {
  at: string;
  actor?: string | null;
  /** "as Site Supervisor" — FR-030. Who acted is half the fact; in what
   *  capacity is the other half. */
  responsibility?: string | null;
  action: string;
  detail?: ReactNode;
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <p className="small muted">Nothing recorded yet.</p>;
  return (
    <ol className="stack-2">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="card card-p stack-2" style={{ padding: 'var(--s3) var(--s4)' }}>
          <div className="row-between wrap" style={{ gap: 'var(--s2)' }}>
            <strong className="small">{e.action}</strong>
            <span className="xs muted num">{new Date(e.at).toLocaleString()}</span>
          </div>
          <span className="small muted">
            {e.actor ?? 'System'}
            {e.responsibility ? ` · as ${e.responsibility}` : ''}
          </span>
          {e.detail ? <div className="small">{e.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
