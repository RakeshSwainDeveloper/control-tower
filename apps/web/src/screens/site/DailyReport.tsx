import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, CloudSun, Send } from 'lucide-react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { StatusChip } from '../../components/StatusChip.js';
import { ErrorBanner, Loading } from '../../components/Feedback.js';

/**
 * S-M07 — Daily report: review and submit. Target 60 seconds.
 *
 * The day's entries are already there — a supervisor recorded them one at a
 * time through S-M03. This screen does not ask them to type any of it again.
 * It shows what will be submitted, takes weather and an optional note, and
 * sends.
 *
 * Manpower is optional and stays optional. `progress.dto.ts` says why in the
 * schema itself: nothing consumes headcount until productivity reporting
 * arrives, and data entry with no return to the person entering it is how a
 * supervisor learns to skip the form altogether (AR-01).
 */
interface Entry {
  id: string; reported_qty: string; unit: string; work_item: string;
  location: string; verification_status: string;
}
interface Report {
  id: string; report_date: string; state_class: string;
  weather: string | null; notes: string | null; submitted_at: string | null;
}

const WEATHER = ['Clear', 'Cloudy', 'Light rain', 'Heavy rain', 'Very hot', 'Windy'];

export function DailyReport() {
  const { projectId, responsibilityFor } = useSession();
  const nav = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [locked, setLocked] = useState(false);
  const [weather, setWeather] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = async () => {
    if (!projectId) { setLoading(false); return; }
    try {
      const r = await api.get<{
        date: string; report: Report | null; locked: boolean; entries: Entry[];
      }>(`/projects/${projectId}/daily-report?date=${today}`);
      setEntries(r.entries ?? []);
      setReport(r.report);
      setLocked(r.locked);
      if (r.report?.weather) setWeather(r.report.weather);
      if (r.report?.notes) setNotes(r.report.notes);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Failed to load', status: 0 }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [projectId]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await api.post<Report>(`/projects/${projectId}/daily-report`, {
        reportDate: today,
        ...(weather ? { weather } : {}),
        ...(notes ? { notes } : {}),
      });
      await api.post(`/projects/${projectId}/daily-report/${saved.id}/submit`, {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError({ title: 'Could not submit', status: 0 }));
    } finally { setBusy(false); }
  };

  if (loading) return <Loading label="Gathering today" />;

  const submitted = report?.state_class === 'submitted' || report?.state_class === 'in_approval'
    || report?.state_class === 'approved';

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <div className="row-between">
        <button type="button" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }}
                onClick={() => nav('/site')}>
          <ArrowLeft size={18} aria-hidden /> Daily report
        </button>
        {report ? <StatusChip state={report.state_class} /> : null}
      </div>
      <p className="small muted">{new Date(today).toDateString()}</p>

      {error ? <ErrorBanner error={error} onRetry={() => void load()} /> : null}

      <section className="stack-2">
        <h2 className="label">
          What you recorded today ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <div className="card card-p stack-2">
            <p className="small">Nothing has been recorded today.</p>
            <button type="button" className="btn" onClick={() => nav('/site/progress')}>
              Record progress first
            </button>
          </div>
        ) : (
          <ul className="stack-2">
            {entries.map((e) => (
              <li key={e.id} className="list-row">
                <span className="grow stack-2" style={{ gap: 0, minWidth: 0 }}>
                  <strong className="truncate small">{e.work_item}</strong>
                  <span className="xs muted truncate">{e.location}</span>
                </span>
                <span className="num" style={{ fontWeight: 600, flex: 'none' }}>
                  {Number(e.reported_qty).toLocaleString()}
                  <span className="muted small"> {e.unit}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {submitted ? (
        <div className="banner banner-ok">
          <Check size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <div className="stack-2">
            <strong>Submitted</strong>
            <span className="small">
              {report?.submitted_at
                ? `Sent ${new Date(report.submitted_at).toLocaleTimeString()}`
                : 'Sent'}
              {' · '}as {responsibilityFor('field.daily_report.submit') ?? 'you'}
            </span>
            {/* An amendment is a new, reasoned act — not an edit. */}
            <span className="xs">
              Changing it now needs an amendment with a reason, which the office sees.
            </span>
          </div>
        </div>
      ) : (
        <>
          <section className="field">
            <span className="label row" style={{ gap: 'var(--s2)' }}>
              <CloudSun size={14} aria-hidden /> Weather
            </span>
            {/* Chips, not a dropdown. One tap, and it is the only thing on this
                screen a supervisor has to decide. */}
            <div className="row wrap" style={{ gap: 'var(--s2)' }}>
              {WEATHER.map((w) => (
                <button key={w} type="button" className="chip-select"
                        aria-pressed={weather === w}
                        onClick={() => setWeather(weather === w ? '' : w)}>
                  {w}
                </button>
              ))}
            </div>
          </section>

          <label className="field">
            <span className="label">Anything worth noting (optional)</span>
            <textarea className="textarea" rows={3} value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Concrete pour delayed to tomorrow — pump broke down" />
          </label>

          <button type="button" className="btn btn-primary btn-block"
                  disabled={busy || locked || entries.length === 0}
                  onClick={() => void submit()}
                  style={{ minHeight: '3.5rem', fontSize: 'var(--text-lg)' }}>
            {busy ? <span className="spinner" aria-hidden /> : <Send size={20} aria-hidden />}
            SUBMIT THE DAY
          </button>
          {locked ? (
            <p className="xs muted">
              Today is locked. Speak to the project manager if something needs to change.
            </p>
          ) : entries.length === 0 ? (
            <p className="xs muted">
              A report with no entries says nothing. Record what was done first.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
