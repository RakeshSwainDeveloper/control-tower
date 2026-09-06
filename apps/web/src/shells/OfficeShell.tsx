import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Building2, CheckSquare, ClipboardList, FolderCog, GitBranch, Inbox, LayoutDashboard,
  LogOut, ScrollText, TriangleAlert, Users,
} from 'lucide-react';
import { useSession } from '../lib/session.js';

/** Nav is permission-driven: an entry a user cannot open is not drawn. */
const NAV: { to: string; label: string; icon: typeof Inbox; permission?: string }[] = [
  { to: '/office',            label: 'Dashboard',   icon: LayoutDashboard, permission: 'report.dashboard.read' },
  { to: '/office/projects',   label: 'Projects',    icon: Building2 },
  { to: '/office/progress',   label: 'Progress',    icon: CheckSquare,     permission: 'field.progress.read' },
  { to: '/office/reports',    label: 'Daily reports', icon: ClipboardList, permission: 'field.daily_report.read' },
  { to: '/office/approvals',  label: 'Approvals',   icon: Inbox },
  { to: '/office/issues',     label: 'Issues',      icon: TriangleAlert,   permission: 'issue.issue.read' },
  { to: '/office/setup',      label: 'Project setup', icon: FolderCog,     permission: 'project.project.update' },
  { to: '/office/people',     label: 'Users & roles', icon: Users,         permission: 'org.user.read' },
  { to: '/office/approval-config', label: 'Approval rules', icon: GitBranch,  permission: 'approval.definition.read' },
  { to: '/office/audit',      label: 'Audit',       icon: ScrollText,      permission: 'audit.log.read' },
];

export function OfficeShell() {
  const { me, can, projects, projectId, setProjectId, signOut } = useSession();
  const nav = useNavigate();

  return (
    <div className="office" style={{ display: 'flex', minHeight: '100%' }}>
      <a href="#main" className="skip">Skip to content</a>

      <nav aria-label="Main" style={{
        width: '15rem', flex: 'none', background: 'var(--card)',
        borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
      }}>
        <div className="row" style={{ padding: 'var(--s4)', gap: 'var(--s3)' }}>
          <span aria-hidden style={{
            width: 28, height: 28, borderRadius: 6, flex: 'none',
            background: 'linear-gradient(135deg, var(--primary), var(--accent))',
          }} />
          <strong>Control Tower</strong>
        </div>

        {projects.length > 1 ? (
          <div style={{ padding: '0 var(--s4) var(--s3)' }}>
            <label className="sr-only" htmlFor="proj">Project</label>
            <select id="proj" className="select" value={projectId ?? ''}
                    onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </div>
        ) : null}

        <ul className="grow" style={{ padding: '0 var(--s2)' }}>
          {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => (
            <li key={n.to}>
              {/* .nav-link carries the active rule as well as the tint —
                  colour is never the sole carrier of meaning (§6). */}
              <NavLink
                to={n.to} end={n.to === '/office'}
                className="nav-link"
              >
                {/* Icon PLUS label, never icon alone (§6 checklist).
                    NavLink adds `active` itself; the stylesheet styles it. */}
                <n.icon size={17} aria-hidden style={{ flex: 'none' }} /> {n.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="stack-2" style={{ padding: 'var(--s4)', borderTop: '1px solid var(--border)' }}>
          <button type="button" className="btn btn-sm" onClick={() => nav('/site')}>
            Site view
          </button>
          <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => { void signOut().then(() => nav('/login')); }}>
            <LogOut size={15} aria-hidden /> Sign out
          </button>
          <span className="xs muted truncate" title={me?.user_id}>{me?.user_id.slice(0, 8)}</span>
        </div>
      </nav>

      <main id="main" className="grow" style={{ padding: 'var(--s6)', maxWidth: '78rem', minWidth: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}
