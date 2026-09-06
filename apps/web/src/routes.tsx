import { Suspense, lazy, type ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Protected } from './components/Gate.js';
import { Loading } from './components/Feedback.js';
import { Placeholder } from './screens/Placeholder.js';
import { RootRedirect } from './screens/RootRedirect.js';

/**
 * Shells load on demand.
 *
 * NFR-03 gives a mobile screen 1.5 seconds to become interactive on a 4 GB
 * Android over 4G. A single bundle means a supervisor downloads the office
 * surface and the platform console they will never open. Split now, at three
 * screens, rather than at thirty.
 */
function lazyShell(load: () => Promise<{ [k: string]: ComponentType }>, name: string) {
  const C = lazy(async () => ({ default: (await load())[name]! }));
  return (
    <Suspense fallback={<Loading label="Loading" />}>
      <C />
    </Suspense>
  );
}

/** Same mechanism for a leaf screen. */
const screen = lazyShell;

const P = (id: string, name: string, wave: string) => <Placeholder id={id} name={name} wave={wave} />;

/**
 * The route table, exported as plain data.
 *
 * The router itself is constructed in App.tsx rather than here: a module-level
 * createBrowserRouter export has an inferred type reaching into
 * @remix-run/router, which pnpm's non-flat node_modules makes unnameable. As
 * data it is also directly usable with createMemoryRouter in tests.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: screen(() => import('./screens/Login.js'), 'OfficeLogin') },
  { path: '/site/login', element: screen(() => import('./screens/Login.js'), 'SiteLogin') },
  { path: '/admin/login', element: screen(() => import('./screens/Login.js'), 'PlatformLogin') },

  /* ── Site (mobile-first) ───────────────────────────────────── */
  {
    path: '/site',
    element: <Protected to="/site/login">{lazyShell(() => import('./shells/SiteShell.js'), 'SiteShell')}</Protected>,
    children: [
      { index: true,               element: screen(() => import('./screens/site/Today.js'), 'Today') },
      { path: 'progress',          element: screen(() => import('./screens/site/ProgressEntry.js'), 'ProgressEntry') },
      { path: 'progress/history',  element: P('S-M14', 'Progress history', 'wave 7') },
      { path: 'report',            element: screen(() => import('./screens/site/DailyReport.js'), 'DailyReport') },
      { path: 'work',              element: screen(() => import('./screens/site/MyWork.js'), 'MyWork') },
      { path: 'verify/:entryId',   element: screen(() => import('./screens/site/Verify.js'), 'Verify') },
      { path: 'approvals/:taskId', element: screen(() => import('./screens/site/ApprovalDecision.js'), 'ApprovalDecision') },
      { path: 'issues',            element: P('S-M12', 'Issues', 'wave 6') },
      { path: 'issues/new',        element: P('S-M10', 'Raise an issue', 'wave 6') },
      { path: 'issues/:issueId',   element: P('S-M11', 'Issue', 'wave 6') },
      { path: 'sync',              element: screen(() => import('./screens/site/SyncStatus.js'), 'SyncStatus') },
      { path: 'me',                element: screen(() => import('./screens/site/Profile.js'), 'Profile') },
    ],
  },

  /* ── Office ────────────────────────────────────────────────── */
  {
    path: '/office',
    element: <Protected>{lazyShell(() => import('./shells/OfficeShell.js'), 'OfficeShell')}</Protected>,
    children: [
      { index: true,                element: P('S-W03', 'Project dashboard', 'wave 7') },
      { path: 'projects',           element: P('S-W02', 'Portfolio', 'wave 7') },
      { path: 'progress',           element: screen(() => import('./screens/office/Workbench.js'), 'Workbench') },
      { path: 'reports',            element: screen(() => import('./screens/office/DailyReports.js'), 'DailyReports') },
      { path: 'reports/:reportId',  element: screen(() => import('./screens/office/DailyReports.js'), 'DailyReportDetail') },
      { path: 'approvals',          element: screen(() => import('./screens/office/Approvals.js'), 'Approvals') },
      { path: 'issues',             element: P('S-W07', 'Issue register', 'wave 6') },
      { path: 'issues/:issueId',    element: P('S-W07', 'Issue', 'wave 6') },
      { path: 'setup',              element: screen(() => import('./screens/office/ProjectSetup.js'), 'ProjectSetup') },
      { path: 'people',             element: screen(() => import('./screens/office/People.js'), 'People') },
      { path: 'approval-config',    element: screen(() => import('./screens/office/ApprovalConfig.js'), 'ApprovalConfig') },
      { path: 'audit',              element: P('S-W11', 'Audit & timeline', 'wave 7') },
    ],
  },

  /* ── Super Admin ───────────────────────────────────────────── */
  {
    path: '/admin',
    element: lazyShell(() => import('./shells/AdminShell.js'), 'AdminShell'),
    children: [
      { index: true,        element: screen(() => import('./screens/admin/Organizations.js'), 'Organizations') },
      { path: 'audit',      element: screen(() => import('./screens/admin/PlatformAudit.js'), 'PlatformAudit') },
      { path: 'health',     element: screen(() => import('./screens/admin/Health.js'), 'AdminHealth') },
    ],
  },

  { path: '*', element: <Navigate to="/" replace /> },
];
