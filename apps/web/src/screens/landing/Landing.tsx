import { useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Camera, CheckCircle2, ClipboardCheck, LayoutDashboard,
  ScrollText, ShieldCheck, Stamp, TriangleAlert, WifiOff,
} from 'lucide-react';
import { Mark } from '../Login.js';
import { BuildingScene, STAGES, useScrollProgress } from './BuildingScene.js';
// Imported here, not in main.tsx, so Vite puts it in the lazy chunk and a
// supervisor opening the app never downloads the marketing stylesheet.
import '../../design/landing.css';

/**
 * The public landing page.
 *
 * Written to be recognisable to someone who runs construction projects, not
 * to a general SaaS audience. Every claim on this page maps to a screen that
 * exists: the numbers in the mock panels are the ones the dashboard actually
 * computes, and the vocabulary — reported, verified, the gap between them —
 * is the product's own.
 *
 * No stock photography, no logo wall, no invented testimonials.
 */
export function Landing() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const progress = useScrollProgress(scrollRef);
  const stage = [...STAGES].reverse().find((s) => progress >= s.at) ?? STAGES[0]!;

  return (
    <div className="lp">
      <SiteHeader />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <header className="lp-hero">
        <div className="lp-wrap lp-hero-grid">
          <div className="stack" style={{ gap: 'var(--s6)' }}>
            <span className="lp-eyebrow">
              <span className="lp-dot" aria-hidden /> Construction project control
            </span>
            <h1 className="lp-h1">
              Know what is happening on every site, what has actually been
              <span className="lp-underline"> verified</span>, and what needs you.
            </h1>
            <p className="lp-lede">
              Site teams record quantities where the work is, with photographs.
              A second person verifies them. Everything else — approvals, issues,
              the daily report, the audit trail — follows from that one habit.
            </p>
            <div className="row wrap" style={{ gap: 'var(--s3)' }}>
              <Link to="/login" className="btn btn-primary lp-cta">
                Sign in <ArrowRight size={17} aria-hidden />
              </Link>
              <a href="#how" className="btn lp-cta">See how it works</a>
            </div>
            <p className="xs" style={{ maxWidth: '32rem' }}>
              Works offline on site. Nothing is lost when the signal goes, and a
              retry never becomes a duplicate entry.
            </p>
          </div>

          <HeroPanel />
        </div>
      </header>

      {/* ── Scroll-driven build ───────────────────────────────── */}
      <section id="how" className="lp-scroll" ref={scrollRef} aria-labelledby="how-h">
        <div className="lp-sticky">
          <div className="lp-wrap lp-scroll-grid">
            <div className="stack" style={{ gap: 'var(--s5)' }}>
              <h2 id="how-h" className="lp-h2">A project, from cleared ground to handover</h2>
              <p className="lp-body">
                Every stage below produces the same three things: a quantity
                somebody recorded, a photograph proving it, and a second person
                who confirmed it. That is what the record is made of.
              </p>
              <ol className="lp-stages">
                {STAGES.map((s) => {
                  const active = stage.label === s.label;
                  const passed = progress > s.at;
                  return (
                    <li key={s.label} data-active={active} data-passed={passed}>
                      <span className="lp-stage-dot" aria-hidden />
                      <span className="stack-2" style={{ gap: 0 }}>
                        <strong>{s.label}</strong>
                        <span className="xs">{s.caption}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            <figure className="lp-scene">
              <BuildingScene progress={progress} />
              <figcaption className="lp-scene-cap">
                <span className="lp-progress" aria-hidden>
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
                <span className="xs num">{Math.round(progress * 100)}% · {stage.label}</span>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* ── The story ─────────────────────────────────────────── */}
      <Story
        kicker="Daily progress"
        icon={ClipboardCheck}
        title="Recorded where the work is, in under a minute"
        body="A supervisor picks the location and the work item — both remembered
              from yesterday — types one quantity, and takes a photograph. Five
              fields, four of them a tap. There is no percentage box anywhere:
              “80% done” is an opinion, “412 of 515 sqm” is a fact."
        panel={<ProgressPanel />}
      />

      <Story
        reverse
        kicker="Evidence"
        icon={Camera}
        title="Every claim carries its proof"
        body="Photographs are captured in the app, stamped with the time, the
              location and who took them — and, where GPS is unavailable inside a
              concrete frame, the reason it is missing. Nothing is ever edited
              after the fact; evidence is immutable at the database level."
        panel={<EvidencePanel />}
      />

      <Story
        kicker="Verification"
        icon={ShieldCheck}
        title="A second person confirms it, and never the same person"
        body="Whoever recorded a quantity cannot verify it. The claim and the
              confirmation are kept as two separate numbers, so an adjustment
              never erases what site originally said — the gap between them is
              the signal the whole product exists to surface."
        panel={<VerifyPanel />}
      />

      <Story
        reverse
        kicker="Approvals"
        icon={Stamp}
        title="Decisions with a name and a capacity on them"
        body="The daily report routes to whoever your workflow says, with an SLA.
              Approvers can approve, reject, hold, or ask a question — and a
              question keeps the clock running, because one that stops it is the
              cheapest way to make a late item look on time."
        panel={<ApprovalPanel />}
      />

      <Story
        kicker="Issues"
        icon={TriangleAlert}
        title="Raised in 45 seconds, closed with proof"
        body="Category and severity are chips, the location is one tap, the camera
              opens directly. An issue cannot be resolved without a photograph of
              the completed work, cannot be signed off by whoever fixed it, and
              cannot close while a question about it is unanswered."
        panel={<IssuePanel />}
      />

      <Story
        reverse
        kicker="Management view"
        icon={LayoutDashboard}
        title="Three questions, answered every morning"
        body="What do I need to know, what needs my action, and what is going
              wrong. Every number states what it counts, when it was computed and
              where the rows behind it are — and the third band shows only what is
              actually wrong, so an empty one means something."
        panel={<DashboardPanel />}
      />

      <Story
        kicker="Audit trail"
        icon={ScrollText}
        title="Who said this was done, and in what capacity"
        body="Append-only, written in the same transaction as the change, and
              readable as sentences rather than a JSON diff. Not just that Ramesh
              approved it — that he approved it as Project Manager, which is the
              answer an auditor is actually asking for."
        panel={<AuditPanel />}
      />

      {/* ── Offline ───────────────────────────────────────────── */}
      <section className="lp-band">
        <div className="lp-wrap lp-offline">
          <WifiOff size={26} aria-hidden />
          <div className="stack-2">
            <h2 className="lp-h3">The fifth floor of a concrete frame has no signal</h2>
            <p className="lp-body">
              So the app does not need one. Work is saved on the device the moment
              it is recorded and sent when the phone next sees a network. Every
              entry carries an idempotency key minted on the device, so a retry
              after a timeout cannot become a second entry — verified against 500
              operations across three devices with induced failures.
            </p>
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section className="lp-cta-band">
        <div className="lp-wrap stack" style={{ gap: 'var(--s5)', alignItems: 'center', textAlign: 'center' }}>
          <h2 className="lp-h2" style={{ color: '#fff' }}>
            Start with one site and one supervisor
          </h2>
          <p className="lp-body" style={{ color: 'rgb(255 255 255 / 0.75)', maxWidth: '38rem' }}>
            The product is built around one habit — record the quantity where the
            work is, and have somebody else confirm it. Everything on this page
            follows from that.
          </p>
          <div className="row wrap" style={{ gap: 'var(--s3)', justifyContent: 'center' }}>
            <Link to="/login" className="btn lp-cta" style={{ background: '#fff', borderColor: '#fff' }}>
              Sign in <ArrowRight size={17} aria-hidden />
            </Link>
            <Link to="/site/login" className="btn lp-cta lp-cta-ghost">
              Sign in from site
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap row-between wrap" style={{ gap: 'var(--s4)' }}>
          <span className="row" style={{ gap: 'var(--s3)' }}>
            <Mark size={28} />
            <strong>Control Tower</strong>
          </span>
          <span className="xs">
            Construction project control · offline-first · append-only audit
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ── Header ─────────────────────────────────────────────────── */
function SiteHeader() {
  return (
    <div className="lp-header">
      <div className="lp-wrap row-between">
        <span className="row" style={{ gap: 'var(--s3)' }}>
          <Mark size={32} />
          <strong style={{ letterSpacing: 'var(--track-tight)' }}>Control Tower</strong>
        </span>
        <nav className="row" style={{ gap: 'var(--s2)' }} aria-label="Landing">
          <a href="#how" className="btn btn-ghost btn-sm lp-nav-link">How it works</a>
          <Link to="/login" className="btn btn-primary btn-sm">Sign in</Link>
        </nav>
      </div>
    </div>
  );
}

/* ── Panels ───────────────────────────────────────────────────
   Compact renderings of real screens, built from the same tokens and
   classes as the application. Not screenshots: an image would be stale
   the first time a screen changed, and would not respond or scale. */

function HeroPanel() {
  return (
    <div className="lp-panel lp-panel-hero" aria-hidden>
      <div className="lp-panel-bar">
        <span /><span /><span />
        <span className="lp-panel-title">Tower B — Residential</span>
      </div>
      <div className="lp-panel-body">
        <div className="lp-metrics">
          {[
            ['62%', 'verified progress', 'reported 71%'],
            ['11%', 'not yet verified', '4 awaiting'],
            ['3', 'approvals open', 'oldest 2 days'],
            ['5', 'issues open', '1 critical'],
          ].map(([v, l, s]) => (
            <div key={l} className="lp-metric">
              <strong>{v}</strong>
              <span className="xs">{l}</span>
              <span className="xs lp-metric-sub">{s}</span>
            </div>
          ))}
        </div>
        <div className="lp-panel-flags">
          <span className="chip" style={{
            background: 'var(--st-rejected-bg)', color: 'var(--st-rejected)',
            borderColor: 'var(--st-rejected-br)' }}>
            2 days with no report
          </span>
          <span className="chip" style={{
            background: 'var(--st-progress-bg)', color: 'var(--st-progress)',
            borderColor: 'var(--st-progress-br)' }}>
            gap widened to 11%
          </span>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lp-panel" aria-hidden>
      <div className="lp-panel-bar"><span /><span /><span />
        <span className="lp-panel-title">{title}</span></div>
      <div className="lp-panel-body stack-2">{children}</div>
    </div>
  );
}

const Row = ({ a, b, c }: { a: string; b: string; c?: React.ReactNode }) => (
  <div className="lp-row">
    <span className="stack-2" style={{ gap: 0, minWidth: 0 }}>
      <strong className="small truncate">{a}</strong>
      <span className="xs truncate">{b}</span>
    </span>
    {c}
  </div>
);

function ProgressPanel() {
  return (
    <Panel title="Progress entry">
      <Row a="Flat 502 › Bathroom" b="Location · from recents" />
      <Row a="Wall plaster 12mm" b="Work item · sqm" />
      <div className="lp-qty">
        <span className="num">12</span><span className="xs">sqm</span>
      </div>
      <div className="stack-2" style={{ gap: 'var(--s1)' }}>
        <div className="bar">
          <span className="bar-done" style={{ width: '58%' }} />
          <span className="bar-pending" style={{ width: '24%' }} />
        </div>
        <span className="xs num">Planned 48 · done 30 → 42 · 62% → 87%</span>
      </div>
    </Panel>
  );
}

function EvidencePanel() {
  return (
    <Panel title="Evidence">
      <div className="thumb-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="thumb" style={{ background: `var(--n-${150 + i * 50})` }} />
        ))}
        <div className="thumb-add"><Camera size={18} aria-hidden />ADD</div>
      </div>
      <span className="xs">07:41 · GPS recorded · as Site Supervisor</span>
    </Panel>
  );
}

function VerifyPanel() {
  return (
    <Panel title="Verification">
      <Row a="Wall plaster 12mm" b="Floor 5 › Flat 502"
           c={<span className="num small" style={{ textAlign: 'right' }}>
                <strong>12</strong> <span className="xs">sqm</span>
                <span className="xs" style={{ display: 'block', color: 'var(--st-progress)' }}>
                  confirmed 9
                </span>
              </span>} />
      <span className="xs">Measured 9 sqm on site, not 12 — Anita Desai as Site Engineer</span>
      <div className="row wrap" style={{ gap: 'var(--s2)' }}>
        <span className="chip" style={{ background: 'var(--st-verified-bg)', color: 'var(--st-verified)', borderColor: 'var(--st-verified-br)' }}>Accept</span>
        <span className="chip" style={{ background: 'var(--st-progress-bg)', color: 'var(--st-progress)', borderColor: 'var(--st-progress-br)' }}>Adjust</span>
        <span className="chip" style={{ background: 'var(--st-rejected-bg)', color: 'var(--st-rejected)', borderColor: 'var(--st-rejected-br)' }}>Reject</span>
      </div>
    </Panel>
  );
}

function ApprovalPanel() {
  return (
    <Panel title="Approvals">
      <Row a="Daily report · TWR" b="Ramesh Kumar as Site Supervisor"
           c={<span className="xs num" style={{ color: 'var(--destructive)', fontWeight: 600 }}>2 days · late</span>} />
      <Row a="Issue closure · critical" b="Anita Desai as Site Engineer"
           c={<span className="xs num">4h</span>} />
      <span className="xs">Sorted by ageing — the oldest is the one that matters</span>
    </Panel>
  );
}

function IssuePanel() {
  return (
    <Panel title="Issue">
      <Row a="Honeycombing on column C4" b="Floor 5 › Flat 502"
           c={<span className="chip" style={{ background: 'var(--sev-high-bg)', color: 'var(--sev-high)', borderColor: 'var(--sev-high-br)' }}>High</span>} />
      <span className="xs">Attach a photo of the completed work before resolving this issue.</span>
      <Row a="Cracked tile in Flat 204" b="Resolved · awaiting a verifier"
           c={<span className="chip" style={{ background: 'var(--st-resolved-bg)', color: 'var(--st-resolved)', borderColor: 'var(--st-resolved-br)' }}>Resolved</span>} />
    </Panel>
  );
}

function DashboardPanel() {
  return (
    <Panel title="Project dashboard">
      <span className="label">What is going wrong</span>
      {[
        ['3 of the last 14 site days have no submitted report.', 'bad'],
        ['11% of reported quantity has not been verified.', 'warn'],
        ['2 issues are past their due date.', 'bad'],
      ].map(([msg, tone]) => (
        <div key={msg} className={tone === 'bad' ? 'banner banner-bad' : 'banner banner-warn'}
             style={{ padding: 'var(--s2) var(--s3)', fontSize: 'var(--text-sm)' }}>
          <TriangleAlert size={15} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <span>{msg}</span>
        </div>
      ))}
    </Panel>
  );
}

function AuditPanel() {
  return (
    <Panel title="Record timeline">
      {[
        ['09:12', 'Ramesh Kumar as Site Supervisor recorded 12 sqm.'],
        ['11:40', 'Anita Desai as Site Engineer changed the quantity to 9.'],
        ['17:05', 'Vikram Shah as Project Manager approved the day.'],
      ].map(([t, line]) => (
        <div key={t} className="row" style={{ gap: 'var(--s3)', alignItems: 'baseline' }}>
          <span className="xs num" style={{ flex: 'none' }}>{t}</span>
          <span className="small">{line}</span>
        </div>
      ))}
      <span className="row xs" style={{ gap: 'var(--s2)' }}>
        <CheckCircle2 size={13} aria-hidden style={{ color: 'var(--st-verified)' }} />
        Append-only. Nothing here can be edited or removed.
      </span>
    </Panel>
  );
}

/* ── Story section ────────────────────────────────────────────── */
function Story({ kicker, icon: Icon, title, body, panel, reverse }: {
  kicker: string; icon: typeof Camera; title: string; body: string;
  panel: React.ReactNode; reverse?: boolean;
}) {
  return (
    <section className="lp-story">
      <div className={`lp-wrap lp-story-grid${reverse ? ' lp-story-reverse' : ''}`}>
        <div className="stack" style={{ gap: 'var(--s4)' }}>
          <span className="lp-kicker"><Icon size={15} aria-hidden /> {kicker}</span>
          <h2 className="lp-h2">{title}</h2>
          <p className="lp-body">{body}</p>
        </div>
        <div className="lp-story-panel">{panel}</div>
      </div>
    </section>
  );
}
