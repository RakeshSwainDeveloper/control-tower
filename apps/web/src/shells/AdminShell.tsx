import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Activity, Building, LogOut, ScrollText } from 'lucide-react';
import { tokens } from '../lib/api.js';

/**
 * The Super Admin shell.
 *
 * Visually distinct from the tenant surface on purpose: a red rule along the
 * top, and the word Platform. Somebody with this access can suspend an
 * organisation, and they should never be a moment's doubt about which product
 * they are looking at.
 */
const NAV = [
  { to: '/admin', label: 'Organizations', icon: Building, end: true },
  { to: '/admin/audit', label: 'Platform audit', icon: ScrollText },
  { to: '/admin/health', label: 'Health & impersonation', icon: Activity },
];

export function AdminShell() {
  const nav = useNavigate();
  return (
    <div style={{ minHeight: '100%' }}>
      <div style={{ height: 3, background: 'var(--destructive)' }} aria-hidden />
      <header className="row-between" style={{
        padding: 'var(--s3) var(--s6)', background: 'var(--primary)', color: 'var(--primary-fg)',
      }}>
        <div className="row" style={{ gap: 'var(--s4)' }}>
          <strong>Control Tower · Platform</strong>
          <nav aria-label="Platform" className="row" style={{ gap: 'var(--s1)' }}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className="nav-link nav-link-invert">
                <n.icon size={16} aria-hidden /> {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'inherit' }}
                onClick={() => { tokens.clear(); nav('/admin/login'); }}>
          <LogOut size={15} aria-hidden /> Sign out
        </button>
      </header>
      <main style={{ padding: 'var(--s6)', maxWidth: '72rem' }}>
        <Outlet />
      </main>
    </div>
  );
}
