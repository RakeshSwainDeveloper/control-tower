import {
  Camera, CheckCircle2, Clock, MapPin, ShieldCheck, TriangleAlert,
} from 'lucide-react';

/**
 * Miniature product interfaces, built from the application's own classes.
 *
 * Not screenshots: an image would be stale the first time a screen changed,
 * would not respond, would not scale on a retina display, and would add
 * hundreds of kilobytes. These use the same tokens, chips, tables and bars as
 * the real screens, so they cannot drift from the product's visual language.
 *
 * Every number here is one the application actually computes. Nothing on this
 * page implies a metric the MVP does not hold — no budget, no schedule, no
 * inventory, no headcount.
 */

export function Frame({ title, children, foot }: {
  title: string; children: React.ReactNode; foot?: React.ReactNode;
}) {
  return (
    <div className="ui" aria-hidden>
      <div className="ui-bar">
        <span className="ui-dots"><i /><i /><i /></span>
        <span className="ui-title">{title}</span>
      </div>
      <div className="ui-body">{children}</div>
      {foot ? <div className="ui-foot">{foot}</div> : null}
    </div>
  );
}

const Chip = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span className="chip" style={{
    background: `var(--st-${tone}-bg)`, color: `var(--st-${tone})`,
    borderColor: `var(--st-${tone}-br)`,
  }}>{children}</span>
);

const Sev = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span className="chip" style={{
    background: `var(--sev-${tone}-bg)`, color: `var(--sev-${tone})`,
    borderColor: `var(--sev-${tone}-br)`,
  }}>{children}</span>
);

/* ── Hero: the project dashboard ─────────────────────────────── */
export function HeroPanel() {
  return (
    <Frame title="Tower B — Residential · Project dashboard">
      <div className="ui-metrics">
        {[
          ['62%', 'verified progress', 'reported 71%'],
          ['11%', 'not yet verified', '4 entries waiting'],
          ['3', 'approvals open', 'oldest 2 days'],
          ['5', 'issues open', '1 critical'],
        ].map(([v, l, s]) => (
          <div key={l} className="ui-metric">
            <strong>{v}</strong>
            <span className="ui-metric-l">{l}</span>
            <span className="ui-metric-s">{s}</span>
          </div>
        ))}
      </div>
      <div className="ui-sep" />
      <span className="ui-label">What is going wrong</span>
      <div className="ui-alert ui-alert-bad">
        <TriangleAlert size={14} aria-hidden />
        2 of the last 14 site days have no submitted report.
      </div>
      <div className="ui-alert ui-alert-warn">
        <TriangleAlert size={14} aria-hidden />
        11% of reported quantity has not been verified.
      </div>
    </Frame>
  );
}

/* ── 01 Record ───────────────────────────────────────────────── */
export function RecordPanel() {
  return (
    <Frame title="Progress entry" foot={
      <span className="ui-meta"><Clock size={12} aria-hidden /> 07:41 · Ramesh Kumar as Site Supervisor</span>
    }>
      <div className="ui-field"><span>Location</span><strong>Floor 5 › Flat 502 › Bathroom</strong></div>
      <div className="ui-field"><span>Work item</span><strong>Wall plaster 12mm</strong></div>
      <div className="ui-qty">
        <span className="ui-qty-n num">12</span>
        <span className="ui-qty-u">sqm</span>
      </div>
      <div className="bar">
        <span className="bar-done" style={{ width: '58%' }} />
        <span className="bar-pending" style={{ width: '24%' }} />
      </div>
      <span className="ui-meta num">Planned 48 · done 30 → 42 · 62% → 87%</span>
    </Frame>
  );
}

/* ── 02 Evidence ─────────────────────────────────────────────── */
export function EvidencePanel() {
  return (
    <Frame title="Evidence" foot={
      <span className="ui-meta"><MapPin size={12} aria-hidden /> 12.9716, 77.5946 · in-app camera · immutable</span>
    }>
      <div className="ui-thumbs">
        {[0, 1, 2].map((i) => (
          <span key={i} className="ui-thumb" style={{ ['--i' as string]: i }} />
        ))}
        <span className="ui-thumb ui-thumb-add"><Camera size={16} aria-hidden />ADD</span>
      </div>
      <div className="ui-sep" />
      <div className="ui-field"><span>Captured</span><strong>07:41:22 on the device</strong></div>
      <div className="ui-field"><span>Attached to</span><strong>Wall plaster 12mm · Flat 502</strong></div>
    </Frame>
  );
}

/* ── 03 Verification — the C-3 rule, made visual ─────────────── */
export function VerifyPanel() {
  return (
    <Frame title="Verification" foot={
      <span className="ui-meta"><ShieldCheck size={12} aria-hidden /> SoD-02 — whoever recorded it cannot verify it</span>
    }>
      {/* Two columns, never one number replacing the other. An adjustment is
          a disagreement that is kept, not a correction that overwrites. */}
      <div className="ui-vs">
        <div>
          <span className="ui-vs-l">Reported</span>
          <strong className="num">12<em>m</em></strong>
          <span className="ui-meta">Ramesh Kumar as Site Supervisor</span>
        </div>
        <span className="ui-vs-div" aria-hidden />
        <div>
          <span className="ui-vs-l">Verified</span>
          <strong className="num" style={{ color: 'var(--st-progress)' }}>9<em>m</em></strong>
          <span className="ui-meta">Anita Desai as Site Engineer</span>
        </div>
      </div>
      <div className="ui-note">
        “Measured 9 m on site, not 12.” The claim is kept as recorded — the
        difference is what the office sees.
      </div>
    </Frame>
  );
}

/* ── 04 Approvals ────────────────────────────────────────────── */
export function ApprovalPanel() {
  return (
    <Frame title="Approvals" foot={
      <span className="ui-meta">Sorted by ageing — the oldest is the one that matters</span>
    }>
      <div className="ui-row">
        <span>
          <strong>Daily report · TWR</strong>
          <span className="ui-meta">Ramesh Kumar as Site Supervisor</span>
        </span>
        <span className="ui-late num">2 days · late</span>
      </div>
      <div className="ui-row">
        <span>
          <strong>Issue closure · critical</strong>
          <span className="ui-meta">Anita Desai as Site Engineer</span>
        </span>
        <span className="ui-meta num">4h</span>
      </div>
      <div className="ui-sep" />
      <div className="ui-decision">
        <CheckCircle2 size={15} aria-hidden />
        <span><strong>Vikram Shah as Project Manager</strong> approved DR/TWR/2026-27/0002.</span>
      </div>
    </Frame>
  );
}

/* ── 05 Issues ───────────────────────────────────────────────── */
export function IssuePanel() {
  return (
    <Frame title="Issue · ISS/TWR/2026-27/0001" foot={
      <span className="ui-meta">High and critical need an approved closure as well as a check</span>
    }>
      <div className="ui-row">
        <span>
          <strong>Honeycombing on column C4</strong>
          <span className="ui-meta">Floor 5 › Flat 502 · assigned to Anita Desai</span>
        </span>
        <Sev tone="high">High</Sev>
      </div>
      <ol className="ui-steps">
        {[
          ['Raised', 'with a photograph', true],
          ['Resolved', 'closure photo required', true],
          ['Verified', 'not by whoever resolved it', true],
          ['Closed', 'no unanswered questions', false],
        ].map(([t, s, done]) => (
          <li key={t as string} data-done={done as boolean}>
            <span className="ui-step-dot" aria-hidden />
            <span><strong>{t}</strong><span className="ui-meta">{s}</span></span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

/* ── 06 Questions / My Work ──────────────────────────────────── */
export function WorkPanel() {
  return (
    <Frame title="My Work" foot={<span className="ui-meta">One list, ordered by what is late</span>}>
      {[
        ['Approve daily report DR/TWR/0002', 'waiting for your approval', '2 days late', true],
        ['Was the plumbing measured or estimated?', 'question addressed to you', 'unanswered', true],
        ['Re-check column C4 after 7 days', 'task assigned to you', 'due in 3 days', false],
        ['Cracked tile in Flat 204', 'issue assigned to you', 'no date', false],
      ].map(([t, s, d, late]) => (
        <div key={t as string} className="ui-row" data-late={late as boolean}>
          <span>
            <strong>{t}</strong>
            <span className="ui-meta">{s}</span>
          </span>
          <span className={late ? 'ui-late num' : 'ui-meta num'}>{d}</span>
        </div>
      ))}
    </Frame>
  );
}

/* ── 07 Audit ────────────────────────────────────────────────── */
export function AuditPanel() {
  return (
    <Frame title="Record timeline · ISS/TWR/2026-27/0001" foot={
      <span className="ui-meta"><CheckCircle2 size={12} aria-hidden /> Append-only. Nothing here can be edited or removed.</span>
    }>
      <ol className="ui-timeline">
        {[
          ['06 Sep · 07:41', 'Ramesh Kumar', 'Site Supervisor', 'raised the issue and attached a photograph.'],
          ['06 Sep · 11:20', 'Anita Desai', 'Site Engineer', 'changed state class from draft to resolved.'],
          ['06 Sep · 14:05', 'Vikram Shah', 'Project Manager', 'verified the resolution.'],
          ['06 Sep · 17:32', 'Vikram Shah', 'Project Manager', 'approved the closure.'],
        ].map(([when, who, cap, what]) => (
          <li key={when as string}>
            <span className="ui-tl-dot" aria-hidden />
            <span className="ui-tl-when num">{when}</span>
            <span className="ui-tl-what">
              <strong>{who}</strong> <em>as {cap}</em> {what}
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

/* ── 08 Portfolio ────────────────────────────────────────────── */
export function PortfolioPanel() {
  return (
    <Frame title="Portfolio" foot={
      <span className="ui-meta">Verified progress is confirmed quantity over planned</span>
    }>
      <table className="ui-table">
        <thead>
          <tr><th>Project</th><th className="n">Verified</th><th className="n">Gap</th><th>Flags</th></tr>
        </thead>
        <tbody>
          {[
            ['TWR', 'Tower B — Residential', '62%', '11%', ['2 days no report']],
            ['NRT', 'North Retail Block', '48%', '4%', []],
            ['SPN', 'Spine Road Works', '77%', '26%', ['26% unverified']],
          ].map(([code, name, v, g, flags]) => (
            <tr key={code as string}>
              <td>
                <strong>{name}</strong>
                <span className="ui-meta">{code}</span>
              </td>
              <td className="n num">{v}</td>
              <td className="n num">{g}</td>
              <td>
                {(flags as string[]).length === 0
                  ? <Chip tone="verified">clear</Chip>
                  : (flags as string[]).map((f) => <Chip key={f} tone="rejected">{f}</Chip>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}
