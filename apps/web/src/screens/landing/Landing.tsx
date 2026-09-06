import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Menu, WifiOff, X } from 'lucide-react';
import { Mark } from '../Login.js';
import { BuildingScene, STAGES, useScrollProgress } from './BuildingScene.js';
import { useReveal } from './reveal.js';
import {
  ApprovalPanel, AuditPanel, EvidencePanel, HeroPanel, IssuePanel,
  PortfolioPanel, RecordPanel, VerifyPanel, WorkPanel,
} from './panels.js';
import '../../design/landing.css';

/**
 * The public landing page.
 *
 * Written for someone who runs construction projects, not for a general SaaS
 * audience. Every claim maps to a screen that exists and uses the product's
 * own vocabulary — reported versus verified, the acting capacity, the
 * idempotency key. No stock photography, no logo wall, no invented customers
 * or statistics, and no metric the MVP does not hold.
 */
export function Landing() {
  useReveal();
  return (
    <div className="lp">
      <Header />
      <Hero />
      <ConstructionStory />
      <ProductStory />
      <Offline />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ══ Header ══════════════════════════════════════════════════ */

const NAV = [
  { label: 'Product', href: '#product' },
  { label: 'Solutions', href: '#story' },
  { label: 'How it works', href: '#record' },
  { label: 'Resources', href: '#audit' },
];

function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // One passive listener with a boolean gate: the class flips once at 8px
    // rather than writing to the DOM on every frame of every scroll.
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <header className="lp-head" data-scrolled={scrolled}>
      <div className="lp-wrap lp-head-in">
        <a href="#top" className="lp-brand">
          <Mark size={30} />
          <span>Control Tower</span>
        </a>

        <nav className="lp-nav" aria-label="Sections">
          {NAV.map((n) => <a key={n.label} href={n.href}>{n.label}</a>)}
        </nav>

        <div className="lp-head-cta">
          <Link to="/login" className="lp-link">Sign in</Link>
          <Link to="/login" className="btn btn-primary btn-sm">Get started</Link>
        </div>

        <button type="button" className="lp-burger" aria-expanded={open}
                aria-label={open ? 'Close menu' : 'Open menu'}
                onClick={() => setOpen((v) => !v)}>
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </div>

      {open ? (
        <div className="lp-sheet">
          <nav aria-label="Sections">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} onClick={() => setOpen(false)}>{n.label}</a>
            ))}
          </nav>
          <div className="lp-sheet-cta">
            <Link to="/login" className="btn btn-block">Sign in</Link>
            <Link to="/login" className="btn btn-primary btn-block">Get started</Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}

/* ══ Hero ════════════════════════════════════════════════════ */

function Hero() {
  return (
    <section className="lp-hero" id="top">
      <div className="lp-wrap">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy" data-reveal>
            <span className="lp-eyebrow">
              <span className="lp-eyebrow-dot" aria-hidden />
              Construction project control
            </span>
            <h1 className="lp-h1">
              Know what&#39;s happening on every site, what has actually been
              <span className="lp-mark"> verified</span>, and what needs you.
            </h1>
            <p className="lp-lede">
              Control Tower is one operational record of the work: the quantity,
              the evidence behind it, the second person who confirmed it, the
              approval, the issues it raised, and who did each of those — in
              what capacity.
            </p>
            <div className="lp-hero-cta">
              <Link to="/login" className="btn btn-primary lp-btn-lg">
                Get started <ArrowRight size={18} aria-hidden />
              </Link>
              <a href="#story" className="btn lp-btn-lg">See how it works</a>
            </div>
            <p className="lp-hero-note">
              Works offline on site. Nothing is lost when the signal goes, and a
              retry never becomes a second entry.
            </p>
          </div>

          <div className="lp-hero-ui" data-reveal>
            <HeroPanel />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ══ Construction story ══════════════════════════════════════
   The scene is a full-bleed pinned layer with the stage list overlaid on
   it — not a figure inside a two-column grid, which is what made it small
   and left the page half empty. */

function ConstructionStory() {
  const ref = useRef<HTMLDivElement>(null);
  const p = useScrollProgress(ref);
  const active = [...STAGES].reverse().find((s) => p >= s.at) ?? STAGES[0]!;

  return (
    <section className="lp-story" id="story" ref={ref} aria-labelledby="story-h">
      <div className="lp-pin">
        <div className="lp-scene">
          <BuildingScene progress={p} />
        </div>

        <div className="lp-scene-top lp-wrap">
          <h2 id="story-h" className="lp-h2 lp-scene-h">
            A project, from cleared ground to handover
          </h2>
          <p className="lp-scene-sub">
            Every stage produces the same three things: a quantity somebody
            recorded, a photograph proving it, and a second person who
            confirmed it.
          </p>
        </div>

        <ol className="lp-stages" aria-label="Construction stages">
          {STAGES.map((s) => {
            const state = active.n === s.n ? 'on' : p > s.at ? 'past' : 'next';
            return (
              <li key={s.n} data-state={state}>
                <span className="lp-stage-n">{s.n}</span>
                <span className="lp-stage-t">
                  <strong>{s.label}</strong>
                  <span>{s.caption}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="lp-rail" aria-hidden>
          <span style={{ transform: `scaleX(${p})` }} />
        </div>
      </div>
    </section>
  );
}

/* ══ Product story ═══════════════════════════════════════════ */

interface Sec {
  id: string; n: string; kicker: string; title: React.ReactNode;
  body: string; panel: React.ReactNode; flip?: boolean; wide?: boolean;
}

const SECTIONS: Sec[] = [
  {
    id: 'record', n: '01', kicker: 'Record progress',
    title: <>Know what work<br />actually happened.</>,
    body: 'A supervisor picks the location and the work item — both remembered '
      + 'from yesterday — types one quantity and takes a photograph. Five fields, '
      + 'four of them a tap. There is no percentage box anywhere: “80% done” is an '
      + 'opinion, “412 of 515 sqm” is a fact.',
    panel: <RecordPanel />,
  },
  {
    id: 'evidence', n: '02', kicker: 'Evidence', flip: true,
    title: <>Every claim<br />carries its proof.</>,
    body: 'Photographs are captured in the app and stamped with the time, the '
      + 'location and who took them — and, where GPS is unavailable inside a '
      + 'concrete frame, the reason it is missing. Evidence is immutable at the '
      + 'database level, not by convention.',
    panel: <EvidencePanel />,
  },
  {
    id: 'verify', n: '03', kicker: 'Verification',
    title: <>A second person confirms it,<br />and never the same person.</>,
    body: 'Whoever recorded a quantity cannot verify it. The claim and the '
      + 'confirmation are kept as two separate numbers, so an adjustment never '
      + 'erases what site originally said — the gap between them is the signal '
      + 'the whole product exists to surface.',
    panel: <VerifyPanel />,
  },
  {
    id: 'approve', n: '04', kicker: 'Approvals', flip: true,
    title: <>Decisions with a name<br />and a capacity on them.</>,
    body: 'The daily report routes to whoever your workflow says, with an SLA. '
      + 'Approvers can approve, reject, hold, or ask a question — and a question '
      + 'keeps the ageing clock running, because one that stops it is the cheapest '
      + 'way to make a late item look on time.',
    panel: <ApprovalPanel />,
  },
  {
    id: 'issues', n: '05', kicker: 'Issues',
    title: <>Raised in 45 seconds,<br />closed with proof.</>,
    body: 'Category and severity are chips, the location is one tap, the camera '
      + 'opens directly. An issue cannot be resolved without a photograph of the '
      + 'completed work, cannot be signed off by whoever fixed it, and cannot close '
      + 'while a question about it is unanswered.',
    panel: <IssuePanel />,
  },
  {
    id: 'work', n: '06', kicker: 'Accountability', flip: true,
    title: <>Three questions,<br />answered every morning.</>,
    body: 'What do I need to know, what needs my action, and what is going wrong. '
      + 'Work addressed to a person arrives in one list ordered by what is late — '
      + 'approvals, tasks, unanswered questions and issues together, because '
      + 'somebody with four inboxes checks none of them.',
    panel: <WorkPanel />,
  },
];

function ProductStory() {
  return (
    <div id="product">
      {SECTIONS.map((s) => (
        <section key={s.id} id={s.id} className="lp-sec" data-flip={s.flip}>
          <div className="lp-wrap lp-sec-grid">
            <div className="lp-sec-copy" data-reveal>
              <span className="lp-kicker"><i>{s.n}</i>{s.kicker}</span>
              <h2 className="lp-h2">{s.title}</h2>
              <p className="lp-body">{s.body}</p>
            </div>
            <div className="lp-sec-ui" data-reveal>{s.panel}</div>
          </div>
        </section>
      ))}

      {/* Audit gets the full width: a timeline reads across, not down a
          half-column, and this is the section that has to feel trustworthy. */}
      <section id="audit" className="lp-sec lp-sec-wide">
        <div className="lp-wrap">
          <div className="lp-wide-head" data-reveal>
            <span className="lp-kicker"><i>07</i>Audit trail</span>
            <h2 className="lp-h2 lp-h2-center">
              Who said this was done, and in what capacity?
            </h2>
            <p className="lp-body lp-body-center">
              Append-only, written in the same transaction as the change, and
              readable as sentences rather than a JSON diff. Not just that Vikram
              approved it — that he approved it <em>as Project Manager</em>, which
              is the question an auditor is actually asking.
            </p>
          </div>
          <div className="lp-wide-ui" data-reveal><AuditPanel /></div>
        </div>
      </section>

      <section className="lp-sec lp-sec-alt">
        <div className="lp-wrap lp-sec-grid" data-flip="true">
          <div className="lp-sec-copy" data-reveal>
            <span className="lp-kicker"><i>08</i>Management view</span>
            <h2 className="lp-h2">One row per project,<br />and the flags in words.</h2>
            <p className="lp-body">
              Verified progress over planned, the gap still awaiting a verifier,
              open approvals and their oldest age, issues past their date, and
              site days with no report. Every number states what it counts, when
              it was computed, and where the rows behind it are.
            </p>
          </div>
          <div className="lp-sec-ui" data-reveal><PortfolioPanel /></div>
        </div>
      </section>
    </div>
  );
}

/* ══ Offline ═════════════════════════════════════════════════ */

function Offline() {
  return (
    <section className="lp-band">
      <div className="lp-wrap lp-band-in" data-reveal>
        <span className="lp-band-icon" aria-hidden><WifiOff size={22} /></span>
        <div>
          <h2 className="lp-h3">The fifth floor of a concrete frame has no signal.</h2>
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
  );
}

/* ══ Final CTA ═══════════════════════════════════════════════ */

function FinalCta() {
  return (
    <section className="lp-cta">
      <div className="lp-wrap lp-cta-in" data-reveal>
        <h2 className="lp-h2 lp-cta-h">Start with one site<br />and see the difference.</h2>
        <p className="lp-cta-p">
          The product is built around one habit — record the quantity where the
          work is, and have somebody else confirm it. Everything on this page
          follows from that.
        </p>
        <div className="lp-cta-row">
          <Link to="/login" className="btn lp-btn-lg lp-btn-light">
            Get started <ArrowRight size={18} aria-hidden />
          </Link>
          <Link to="/site/login" className="btn lp-btn-lg lp-btn-onDark">
            Sign in from site
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ══ Footer ══════════════════════════════════════════════════ */

const FOOTER = [
  ['Product', [['Record progress', '#record'], ['Evidence', '#evidence'],
               ['Verification', '#verify'], ['Approvals', '#approve']]],
  ['Solutions', [['Issues', '#issues'], ['Accountability', '#work'],
                 ['Management view', '#product'], ['Offline site work', '#story']]],
  ['Resources', [['How it works', '#story'], ['Audit trail', '#audit']]],
  ['Company', [['Sign in', '/login'], ['Sign in from site', '/site/login']]],
] as const;

function Footer() {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap">
        <div className="lp-foot-grid">
          <div className="lp-foot-brand">
            <span className="lp-brand lp-brand-dark">
              <Mark size={30} /><span>Control Tower</span>
            </span>
            <p>Construction project control. Offline-first, evidence-backed,
               append-only.</p>
          </div>
          {FOOTER.map(([heading, links]) => (
            <nav key={heading} aria-label={heading}>
              <h3>{heading}</h3>
              <ul>
                {links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith('#')
                      ? <a href={href}>{label}</a>
                      : <Link to={href}>{label}</Link>}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="lp-foot-base">
          <span>Control Tower</span>
          <span>Every quantity recorded where the work is, and confirmed by
                somebody else.</span>
        </div>
      </div>
    </footer>
  );
}
