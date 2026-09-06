import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

/**
 * Every aggregate in this product carries `definition`, `as_of` and `drill`
 * (FR-522). This component is the reason that contract is worth having: a
 * number on a dashboard is only trustworthy if the person reading it can see
 * what it counts, when it was computed, and the rows behind it.
 *
 * A metric rendered without these is a rumour with a font.
 */
export interface Metric {
  metric?: string;
  definition?: string;
  as_of?: string;
  drill?: { endpoint?: string; params?: Record<string, unknown> } | null;
}

export function MetricValue({
  value, unit, label, metric, to,
}: {
  value: string | number;
  unit?: string;
  label: string;
  metric?: Metric;
  /** In-app route for the drill. The API `endpoint` is the server's view of it. */
  to?: string;
}) {
  const body = (
    <>
      <span className="row-between" style={{ alignItems: 'baseline' }}>
        <span className="num" style={{ fontSize: 'var(--text-2xl)', fontWeight: 600 }}>
          {value}
          {unit ? <span className="muted small" style={{ marginLeft: 4 }}>{unit}</span> : null}
        </span>
      </span>
      <span className="small muted">{label}</span>
    </>
  );

  return (
    <div className="card card-p stack-2">
      {to ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{body}</Link> : body}
      {metric?.definition ? (
        <span className="xs muted row" style={{ gap: 'var(--s1)', alignItems: 'flex-start' }}>
          <Info size={13} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <span>
            {metric.definition}
            {metric.as_of ? ` · as of ${new Date(metric.as_of).toLocaleString()}` : ''}
          </span>
        </span>
      ) : null}
    </div>
  );
}
