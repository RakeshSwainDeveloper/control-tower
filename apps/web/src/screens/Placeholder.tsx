import { Construction } from 'lucide-react';

/**
 * A screen that has a route and a shell but no implementation yet.
 *
 * It names the screen id and the wave it belongs to rather than showing an
 * empty page. A blank screen in a demo reads as a bug; a screen that says
 * "S-W10, wave 2" reads as a plan.
 */
export function Placeholder({ id, name, wave }: { id: string; name: string; wave: string }) {
  return (
    <div className="empty card">
      <Construction size={28} aria-hidden />
      <div className="stack-2">
        <strong>{name}</strong>
        <span className="small">{id} · scheduled in {wave}</span>
      </div>
    </div>
  );
}
