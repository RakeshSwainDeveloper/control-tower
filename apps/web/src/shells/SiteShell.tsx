import { NavLink, Outlet } from 'react-router-dom';
import { Home, Inbox, TriangleAlert, User } from 'lucide-react';
import { SyncBadge } from '../components/SyncBadge.js';
import { useProject, useSession } from '../lib/session.js';

/**
 * The site shell.
 *
 * Four destinations, bottom-anchored, because the phone is held one-handed
 * while the other hand holds a tape or a railing. Anything at the top of a
 * 6-inch screen needs a grip change to reach, and a grip change on a scaffold
 * is a real cost.
 *
 * The header carries the project and the sync badge and nothing else: those
 * are the two facts a supervisor needs to trust what they are about to record.
 */
const TABS = [
  { to: '/site',        label: 'Today',  icon: Home,          end: true },
  { to: '/site/work',   label: 'My Work', icon: Inbox },
  { to: '/site/issues', label: 'Issues', icon: TriangleAlert, permission: 'issue.issue.read' },
  { to: '/site/me',     label: 'Profile', icon: User },
];

export function SiteShell() {
  const project = useProject();
  const { can } = useSession();
  const tabs = TABS.filter((t) => !t.permission || can(t.permission));

  return (
    <div className="site" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <header className="row-between" style={{
        padding: 'var(--s3) var(--s4)', background: 'var(--card)',
        borderBottom: '1px solid var(--border)',
        position: 'sticky', top: 0, zIndex: 10,
        paddingTop: 'max(var(--s3), env(safe-area-inset-top))',
      }}>
        <div className="stack-2" style={{ gap: 0, minWidth: 0 }}>
          <strong className="truncate">{project?.name ?? 'Control Tower'}</strong>
          {project ? <span className="xs muted">{project.code}</span> : null}
        </div>
        <SyncBadge />
      </header>

      <main className="grow" style={{ padding: 'var(--s4)', paddingBottom: 'var(--s8)', minWidth: 0 }}>
        <Outlet />
      </main>

      <nav aria-label="Sections" style={{
        position: 'sticky', bottom: 0, display: 'flex',
        background: 'var(--card)', borderTop: '1px solid var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {tabs.map((t) => (
          <NavLink
            key={t.to} to={t.to} end={t.end}
            style={({ isActive }) => ({
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 2,
              minHeight: 'var(--touch)', padding: 'var(--s2) 0',
              textDecoration: 'none', fontSize: 'var(--text-xs)', fontWeight: 600,
              color: isActive ? 'var(--accent)' : 'var(--muted-fg)',
            })}
          >
            <t.icon size={20} aria-hidden />
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
