import { useEffect, useState } from 'react';

/**
 * The construction scene.
 *
 * One SVG whose every part is a function of a single number between 0 and 1.
 * Nothing switches on; everything interpolates, so at any scroll position the
 * building is in a state a real one could be in — the crane climbs as the
 * frame rises, walls infill a floor at a time behind the structure, glazing
 * follows the walls, and the crane leaves before the landscaping arrives.
 *
 * Deliberately no animation library, no sprite sheet, no video: ~6 KB of
 * inline SVG driven by one rAF-throttled scroll listener. A page arguing that
 * a construction site should do more with less should not ship a megabyte of
 * runtime to say so.
 */

export interface Stage { n: string; at: number; label: string; caption: string }

export const STAGES: Stage[] = [
  { n: '01', at: 0.00, label: 'Site',       caption: 'Ground cleared.' },
  { n: '02', at: 0.14, label: 'Foundation', caption: 'Excavation and footings.' },
  { n: '03', at: 0.32, label: 'Structure',  caption: 'Columns and slabs rising.' },
  { n: '04', at: 0.52, label: 'Floors',     caption: 'Blockwork and internal work.' },
  { n: '05', at: 0.72, label: 'Finishing',  caption: 'Plaster, glazing and services.' },
  { n: '06', at: 0.90, label: 'Handover',   caption: 'Every quantity verified.' },
];

/** Normalised 0..1 across a window, with a gentle ease so nothing snaps. */
const span = (p: number, from: number, to: number): number => {
  const t = Math.max(0, Math.min(1, (p - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function useScrollProgress(ref: React.RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // With reduced motion the scene is shown finished rather than animating
    // past the reader — the information is the building, not the movement.
    // Guarded: matchMedia is absent in jsdom and some older Android WebViews,
    // and throwing here would take the page down rather than one animation.
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

const FLOORS = 9;
const GROUND = 610;
const FLOOR_H = 52;
const BX = 400;          // building left edge
const BW = 400;          // building width

export function BuildingScene({ progress: p }: { progress: number }) {
  const dig       = span(p, 0.06, 0.18);
  const footings  = span(p, 0.13, 0.24);
  const craneIn   = span(p, 0.20, 0.30);
  const craneOut  = span(p, 0.88, 0.97);
  const roof      = span(p, 0.78, 0.88);
  const site      = span(p, 0.02, 0.12);
  const siteOut   = span(p, 0.86, 0.95);
  const green     = span(p, 0.90, 1.00);
  const glow      = span(p, 0.92, 1.00);

  // The crane climbs with the frame and always stands a little above it.
  const topFloor = Math.min(FLOORS, Math.floor(span(p, 0.26, 0.80) * FLOORS + 0.4));
  const craneTop = GROUND - (topFloor + 1.6) * FLOOR_H;

  return (
    <svg viewBox="0 0 1200 760" role="img" preserveAspectRatio="xMidYMax meet"
         aria-label={`Construction progress, ${Math.round(p * 100)} percent complete`}
         className="scene-svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#eef4fb" />
          <stop offset="55%"  stopColor="#f6f9fc" />
          <stop offset="100%" stopColor="#fbfcfe" />
        </linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#dff1fd" />
          <stop offset="55%"  stopColor="#a5dbf7" />
          <stop offset="100%" stopColor="#7cc7ee" />
        </linearGradient>
        <linearGradient id="slabTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#94a3b8" />
        </linearGradient>
        <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e7ecf2" />
          <stop offset="100%" stopColor="#f4f7fa" />
        </linearGradient>
        <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      <rect width="1200" height="760" fill="url(#sky)" />

      {/* Distant skyline: context, never detail. Kept pale so it reads as
          depth rather than as another building to look at. */}
      <g opacity="0.5" fill="#dbe3ec">
        <rect x="60"  y="470" width="70"  height="140" rx="3" />
        <rect x="140" y="510" width="52"  height="100" rx="3" />
        <rect x="960" y="452" width="86"  height="158" rx="3" />
        <rect x="1056" y="500" width="60" height="110" rx="3" />
        <rect x="200" y="536" width="42"  height="74"  rx="3" />
      </g>

      {/* Ground plane */}
      <rect x="0" y={GROUND} width="1200" height={760 - GROUND} fill="url(#ground)" />
      <line x1="0" y1={GROUND} x2="1200" y2={GROUND} stroke="#cbd5e1" strokeWidth="2" />

      {/* Soft contact shadow under the building, deepening as it grows. */}
      <ellipse cx={BX + BW / 2} cy={GROUND + 12} rx={BW * 0.62} ry="20"
               fill="#0f172a" opacity={0.05 + topFloor * 0.012} filter="url(#soft)" />

      {/* Site logistics: hoarding, material stacks, a container. They arrive
          early and clear before handover, which is what makes the last stage
          read as finished rather than as one more floor. */}
      <g opacity={site * (1 - siteOut)}>
        <g stroke="#cbd5e1" strokeWidth="3">
          <line x1="150" y1={GROUND} x2="150" y2={GROUND - 46} />
          <line x1="1050" y1={GROUND} x2="1050" y2={GROUND - 46} />
        </g>
        <rect x="150" y={GROUND - 46} width="900" height="6" rx="2" fill="#e2e8f0" />
        <g fill="#cbd5e1">
          <rect x="196" y={GROUND - 26} width="88" height="26" rx="3" />
          <rect x="204" y={GROUND - 40} width="72" height="14" rx="3" />
          <rect x="900" y={GROUND - 34} width="112" height="34" rx="4" fill="#b7c4d4" />
        </g>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={300 + i * 26} y={GROUND - 14} width="20" height="14" rx="2" fill="#dbe3ec" />
        ))}
      </g>

      {/* Excavation, then footings. */}
      <g opacity={dig}>
        <path d={`M${BX - 26} ${GROUND} h${BW + 52} l-18 34 h-${BW + 16} Z`} fill="#dbe3ec" />
        <g opacity={footings} fill="#94a3b8">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={BX + 16 + i * (BW - 60) / 3} y={GROUND - 12}
                  width="44" height="20" rx="2" />
          ))}
        </g>
        <rect x={BX - 10} y={GROUND - 16} width={BW + 20} height="16" rx="2"
              fill="#b7c4d4" opacity={footings} />
      </g>

      {/* The frame. Each floor: slab, columns, then wall infill and glazing
          that lag behind the structure the way they do on a real programme. */}
      {Array.from({ length: FLOORS }, (_, i) => {
        const from = 0.26 + i * 0.052;
        const rise = span(p, from, from + 0.075);
        if (rise <= 0) return null;

        const y = GROUND - (i + 1) * FLOOR_H;
        const wall = span(p, from + 0.10, from + 0.20);
        const glazed = span(p, 0.66 + i * 0.022, 0.78 + i * 0.022);
        const cols = [BX + 8, BX + BW / 3, BX + (2 * BW) / 3, BX + BW - 22];

        return (
          <g key={i} opacity={Math.min(1, rise * 1.25)}
             transform={`translate(0 ${(1 - rise) * 34})`}>
            {/* Slab */}
            <rect x={BX - 8} y={y} width={BW + 16} height="11" rx="2" fill="url(#slabTop)" />
            {/* Columns */}
            {cols.map((x) => (
              <rect key={x} x={x} y={y + 11} width="14" height={FLOOR_H - 11} fill="#b7c4d4" />
            ))}
            {/* Wall infill */}
            <g opacity={wall}>
              <rect x={BX + 26} y={y + 13} width={BW / 2 - 40} height={FLOOR_H - 15}
                    fill={glazed > 0.5 ? '#eef2f7' : '#dbe3ec'} />
              <rect x={BX + BW / 2 + 14} y={y + 13} width={BW / 2 - 40} height={FLOOR_H - 15}
                    fill={glazed > 0.5 ? '#eef2f7' : '#dbe3ec'} />
            </g>
            {/* Glazing */}
            <g opacity={glazed}>
              <rect x={BX + 36} y={y + 20} width={BW / 2 - 60} height={FLOOR_H - 30}
                    rx="2" fill="url(#glass)" />
              <rect x={BX + BW / 2 + 24} y={y + 20} width={BW / 2 - 60} height={FLOOR_H - 30}
                    rx="2" fill="url(#glass)" />
            </g>
          </g>
        );
      })}

      {/* Roof parapet and plant */}
      <g opacity={roof} transform={`translate(0 ${(1 - roof) * 18})`}>
        <rect x={BX - 14} y={GROUND - FLOORS * FLOOR_H - 16} width={BW + 28} height="16"
              rx="3" fill="#64748b" />
        <rect x={BX + BW - 130} y={GROUND - FLOORS * FLOOR_H - 44} width="72" height="28"
              rx="3" fill="#94a3b8" />
        <rect x={BX + 40} y={GROUND - FLOORS * FLOOR_H - 34} width="34" height="18"
              rx="3" fill="#94a3b8" />
      </g>

      {/* Tower crane. Climbs with the frame, then tracks off to the right. */}
      <g opacity={craneIn * (1 - craneOut)}
         transform={`translate(${craneOut * 260} ${craneOut * 10})`}>
        <rect x="852" y={craneTop} width="14" height={GROUND - craneTop} fill="#94a3b8" />
        {Array.from({ length: 9 }, (_, i) => {
          const yy = craneTop + 26 + i * 42;
          return yy < GROUND ? (
            <line key={i} x1="852" y1={yy} x2="866" y2={yy - 18}
                  stroke="#cbd5e1" strokeWidth="2" />
          ) : null;
        })}
        <rect x="640" y={craneTop - 10} width="330" height="9" rx="2" fill="#64748b" />
        <rect x="838" y={craneTop - 30} width="42" height="20" rx="3" fill="#475569" />
        <line x1="700" y1={craneTop - 1} x2="700"
              y2={lerp(craneTop + 90, GROUND - 40, 1 - span(p, 0.3, 0.85))}
              stroke="#94a3b8" strokeWidth="2" />
        <rect x="686" y={lerp(craneTop + 90, GROUND - 40, 1 - span(p, 0.3, 0.85))}
              width="28" height="18" rx="2" fill="#d97706" />
      </g>

      {/* Handover: landscaping, and a lit ground floor. Small, but it is what
          tells somebody at a glance that this stage is the end. */}
      <g opacity={green}>
        {[250, 300, 940, 990].map((x, i) => (
          <g key={x}>
            <rect x={x} y={GROUND - 30} width="6" height="30" rx="2" fill="#94a3b8" />
            <circle cx={x + 3} cy={GROUND - 40} r={20 - (i % 2) * 5} fill="#86efac" />
            <circle cx={x - 8} cy={GROUND - 28} r={13 - (i % 2) * 3} fill="#bbf7d0" />
          </g>
        ))}
      </g>
      <g opacity={glow}>
        <rect x={BX + 30} y={GROUND - FLOOR_H + 16} width={BW - 60} height={FLOOR_H - 28}
              rx="2" fill="#fde68a" opacity="0.65" />
      </g>
    </svg>
  );
}
