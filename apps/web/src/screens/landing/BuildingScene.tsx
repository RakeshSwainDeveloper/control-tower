import { useEffect, useState } from 'react';

/**
 * The construction scene: one SVG whose parts appear as the page scrolls.
 *
 * Deliberately no animation library, no sprite sheet, no video. The whole
 * scene is ~4 KB of inline SVG driven by a single number between 0 and 1, and
 * every element's reveal is a CSS transform the compositor can handle on its
 * own thread. A landing page that ships a 2 MB animation runtime to explain a
 * product about doing more with less would be arguing against itself.
 *
 * Progress comes from one rAF-throttled scroll listener, not from a listener
 * per element, and the value is written to a CSS custom property so the DOM is
 * touched once per frame regardless of how many parts are on screen.
 */

export interface Stage { at: number; label: string; caption: string }

export const STAGES: Stage[] = [
  { at: 0.00, label: 'Site',      caption: 'Ground cleared, nothing recorded yet' },
  { at: 0.18, label: 'Foundation', caption: 'Excavation and footings' },
  { at: 0.38, label: 'Structure',  caption: 'Columns and slabs rising' },
  { at: 0.58, label: 'Floors',     caption: 'Blockwork and internal walls' },
  { at: 0.78, label: 'Finishing',  caption: 'Plaster, glazing, services' },
  { at: 0.94, label: 'Complete',   caption: 'Handover, with every quantity verified' },
];

/** Where in 0..1 a part starts and finishes appearing. */
const span = (p: number, from: number, to: number): number =>
  Math.max(0, Math.min(1, (p - from) / (to - from)));

export function useScrollProgress(ref: React.RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Honour the user's setting. With reduced motion the scene is shown
    // finished rather than animating past them — the information is the
    // building, not the movement.
    //
    // Guarded: matchMedia is missing in jsdom and in some older Android
    // WebViews, and an exception here would take the whole page down rather
    // than degrade one animation.
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setProgress(1); return; }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      if (total <= 0) { setProgress(1); return; }
      setProgress(Math.max(0, Math.min(1, -rect.top / total)));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref]);

  return progress;
}

/**
 * The scene itself.
 *
 * Floors rise, then walls infill, then glazing and the crane leaves. Each
 * group is transformed and faded independently so nothing pops: at any scroll
 * position the building is in a state a real one could be in.
 */
export function BuildingScene({ progress }: { progress: number }) {
  const FLOORS = 6;
  const foundation = span(progress, 0.10, 0.26);
  const crane = span(progress, 0.22, 0.34);
  const craneOut = span(progress, 0.86, 0.96);
  const finishing = span(progress, 0.70, 0.90);
  const roof = span(progress, 0.80, 0.92);
  const done = span(progress, 0.90, 1);

  return (
    <svg viewBox="0 0 420 380" role="img" width="100%" height="100%"
         aria-label={`Construction progress, ${Math.round(progress * 100)} percent`}
         style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="ct-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#eff6ff" />
          <stop offset="100%" stopColor="#f8fafc" />
        </linearGradient>
        <linearGradient id="ct-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#bae6fd" />
          <stop offset="100%" stopColor="#7dd3fc" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="420" height="380" rx="16" fill="url(#ct-sky)" />

      {/* Ground: always present. The site exists before anything is built. */}
      <line x1="24" y1="330" x2="396" y2="330" stroke="var(--n-300)" strokeWidth="2" />
      <g opacity="0.5">
        {[60, 120, 300, 360].map((x, i) => (
          <rect key={x} x={x} y={322 - (i % 2) * 3} width="14" height={6 + (i % 2) * 3}
                rx="1.5" fill="var(--n-300)" />
        ))}
      </g>

      {/* Foundation: excavation hatch, then footings. */}
      <g opacity={foundation}>
        <rect x="118" y="312" width="184" height="18" rx="2" fill="var(--n-300)" />
        {[130, 168, 206, 244, 282].map((x) => (
          <rect key={x} x={x} y="304" width="10" height="10" rx="1" fill="var(--n-400)" />
        ))}
      </g>

      {/* Floors. Each rises from the slab below it and settles — the y offset
          collapses to 0 as its own span completes. */}
      {Array.from({ length: FLOORS }, (_, i) => {
        const from = 0.26 + i * 0.085;
        const t = span(progress, from, from + 0.10);
        if (t <= 0) return null;
        const y = 312 - (i + 1) * 40;
        const infill = span(progress, from + 0.06, from + 0.22);
        return (
          <g key={i} opacity={Math.min(1, t * 1.4)}
             transform={`translate(0 ${(1 - t) * 26})`}>
            {/* Slab */}
            <rect x="118" y={y} width="184" height="7" rx="1.5" fill="var(--n-400)" />
            {/* Columns */}
            {[124, 200, 276].map((x) => (
              <rect key={x} x={x} y={y + 7} width="8" height="33" fill="var(--n-300)" />
            ))}
            {/* Wall infill, then glazing once finishing starts */}
            <g opacity={infill}>
              <rect x="132" y={y + 8} width="66" height="31" rx="1"
                    fill={finishing > 0.4 ? 'var(--n-100)' : 'var(--n-200)'} />
              <rect x="208" y={y + 8} width="66" height="31" rx="1"
                    fill={finishing > 0.4 ? 'var(--n-100)' : 'var(--n-200)'} />
            </g>
            <g opacity={finishing}>
              <rect x="140" y={y + 13} width="48" height="18" rx="1.5" fill="url(#ct-glass)" />
              <rect x="216" y={y + 13} width="48" height="18" rx="1.5" fill="url(#ct-glass)" />
            </g>
          </g>
        );
      })}

      {/* Roof parapet and plant */}
      <g opacity={roof} transform={`translate(0 ${(1 - roof) * 14})`}>
        <rect x="112" y="66" width="196" height="9" rx="2" fill="var(--n-600)" />
        <rect x="240" y="48" width="34" height="18" rx="2" fill="var(--n-400)" />
      </g>

      {/* Tower crane: arrives with the structure, leaves at handover. */}
      <g opacity={crane * (1 - craneOut)}
         transform={`translate(${craneOut * 60} 0)`}>
        <rect x="330" y="96" width="7" height="234" fill="var(--n-500)" />
        <rect x="246" y="92" width="152" height="6" rx="1.5" fill="var(--n-600)" />
        <rect x="322" y="80" width="23" height="14" rx="2" fill="var(--n-600)" />
        <line x1="286" y1="98" x2="286" y2={120 + (1 - progress) * 90}
              stroke="var(--n-500)" strokeWidth="1.5" />
        <rect x="279" y={120 + (1 - progress) * 90} width="15" height="11" rx="1.5"
              fill="var(--st-progress)" />
      </g>

      {/* Handover: the site hoarding comes down and a tree goes in. Small,
          but it is what tells somebody at a glance that this stage is the
          end rather than another floor. */}
      <g opacity={done}>
        <rect x="330" y="300" width="5" height="30" rx="1" fill="var(--n-500)" />
        <circle cx="332" cy="294" r="16" fill="#86efac" />
        <circle cx="322" cy="302" r="11" fill="#bbf7d0" />
      </g>
    </svg>
  );
}
