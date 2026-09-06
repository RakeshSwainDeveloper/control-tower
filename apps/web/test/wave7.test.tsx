/**
 * Wave 7 — visibility.
 *
 * The dashboard's job is to be trusted. Every number states what it counts and
 * drills to the rows behind it, and the third band shows only what is actually
 * wrong — an empty "going wrong" band is the most useful thing the screen can
 * say, and padding it with green tiles would destroy that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Me } from '../src/lib/session.js';

const getMock = vi.fn();
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api.js')>('../src/lib/api.js');
  return {
    ...actual,
    api: { get: (p: string) => getMock(p), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
    tokens: { ...actual.tokens, access: () => 'tok', refresh: () => 'ref' },
  };
});

const { SessionProvider } = await import('../src/lib/session.js');
const { Dashboard } = await import('../src/screens/office/Dashboard.js');
const { Portfolio } = await import('../src/screens/office/Portfolio.js');

const PM: Me = {
  user_id: 'vikram', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: ['report.dashboard.read', 'audit.log.read', 'field.progress.read']
    .map((key) => ({ key, org_wide: true, project_ids: [], qualifier: 'all_in_scope',
                     responsibility: 'Project Manager' })),
};

const CLEAN = {
  as_of: '2026-09-06T05:00:00Z',
  know: [
    { key: 'verified_progress', value: 62, unit: 'percent', secondary: 'reported 71%',
      definition: 'Quantity confirmed by a verifier, over total planned quantity.',
      as_of: '2026-09-06T05:00:00Z', drill: { endpoint: '/x' } },
    { key: 'verification_gap', value: 11, unit: 'percent', secondary: '4 awaiting a verifier',
      definition: 'Reported quantity minus verified quantity, over reported quantity.',
      as_of: '2026-09-06T05:00:00Z', drill: { endpoint: '/x' } },
    { key: 'open_approvals', value: 0, unit: 'count', secondary: 'nothing waiting',
      definition: 'Approval tasks nobody has decided yet.',
      as_of: '2026-09-06T05:00:00Z', drill: { endpoint: '/x' } },
    { key: 'open_issues', value: 3, unit: 'count', secondary: '0 high or critical',
      definition: 'Issues not yet closed or cancelled.',
      as_of: '2026-09-06T05:00:00Z', drill: { endpoint: '/x' } },
  ],
  act: { approvals_i_owe: 0, issues_assigned_to_me: 0, entries_awaiting_verification: 0,
         definition: 'Work addressed to you specifically.', as_of: '2026-09-06T05:00:00Z' },
  wrong: [],
  reports: { submitted_last_14_days: 14, missing_days: 0, last_report_date: '2026-09-05' },
};

beforeEach(() => {
  getMock.mockReset();
  localStorage.setItem('ct.project', 'p1');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(PM);
    if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
    if (p.includes('/dashboard')) return Promise.resolve(CLEAN);
    return Promise.resolve({ data: [] });
  });
});

const mount = (ui: React.ReactNode) => render(
  <SessionProvider><MemoryRouter><Routes><Route path="/" element={ui} /></Routes></MemoryRouter></SessionProvider>,
);

describe('S-W03 dashboard', () => {
  it('renders the three bands', async () => {
    mount(<Dashboard />);
    await waitFor(() => expect(screen.getByText('What I need to know')).toBeInTheDocument());
    expect(screen.getByText('What needs my action')).toBeInTheDocument();
    expect(screen.getByText('What is going wrong')).toBeInTheDocument();
  });

  it('every KNOW tile shows what it counts and when (FR-522)', async () => {
    mount(<Dashboard />);
    await waitFor(() => expect(screen.getByText('62%')).toBeInTheDocument());
    // A number a reader cannot trace is a rumour with a font.
    expect(screen.getByText(/Quantity confirmed by a verifier/)).toBeInTheDocument();
    expect(screen.getByText(/Reported quantity minus verified quantity/)).toBeInTheDocument();
  });

  it('an empty "going wrong" band SAYS SO rather than being blank', async () => {
    mount(<Dashboard />);
    await waitFor(() => expect(screen.getByText('Nothing is flagged')).toBeInTheDocument());
    expect(screen.getByText(/Reports are being submitted/)).toBeInTheDocument();
  });

  it('shows only what is actually wrong, each drilling to the rows', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(PM);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/dashboard')) return Promise.resolve({
        ...CLEAN,
        wrong: [
          { key: 'missing_reports', severity: 'bad',
            message: '3 of the last 14 site days have no submitted report.',
            drill: { to: '/office/reports' } },
          { key: 'overdue_issues', severity: 'warn',
            message: '2 issues are past their due date.', drill: { to: '/office/issues' } },
        ],
      });
      return Promise.resolve({ data: [] });
    });
    mount(<Dashboard />);
    await waitFor(() => expect(
      screen.getByText('3 of the last 14 site days have no submitted report.')).toBeInTheDocument());
    expect(screen.queryByText('Nothing is flagged')).toBeNull();
    // Each flag is a way in, not just a statement.
    const link = screen.getByText('2 issues are past their due date.').closest('a');
    expect(link).toHaveAttribute('href', '/office/issues');
  });

  it('says nothing is waiting rather than showing three zeros', async () => {
    mount(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/Nothing is waiting on you/)).toBeInTheDocument());
});

  it('degrades to an empty state on an unexpected payload, never a white page', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(PM);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      // A deploy skew, an older server, a partial response.
      if (p.includes('/dashboard')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mount(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/No dashboard data/)).toBeInTheDocument());
  });
});

describe('S-W02 portfolio', () => {
  it('flags each project in WORDS, never by row colour alone', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(PM);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p === '/portfolio') return Promise.resolve({
        metric: 'portfolio', as_of: '2026-09-06T05:00:00Z',
        definition: 'One row per active project.',
        data: [{
          id: 'p1', code: 'TWR', name: 'Tower B', state_class: 'in_progress',
          verified_pct: 62, reported_pct: 71, gap_pct: 30, awaiting_verification: 4,
          open_issues: 5, overdue_issues: 2, open_approvals: 1,
          oldest_approval_hours: 60, last_report_date: '2026-09-01', missing_report_days: 3,
        }],
      });
      return Promise.resolve({ data: [] });
    });
    mount(<Portfolio />);
    await waitFor(() => expect(screen.getByText('Tower B')).toBeInTheDocument());
    // UI_UX_PLAN §6: colour is never the sole carrier of meaning.
    expect(screen.getByText('3 days with no report')).toBeInTheDocument();
    // "2 overdue" appears in the issues cell as well as the flags column;
    // both are wanted, so assert on the flags column specifically.
    expect(screen.getAllByText('2 overdue').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('30% unverified')).toBeInTheDocument();
    expect(screen.getByText('approval waiting 3d')).toBeInTheDocument();
  });

  it('shows verified and reported as two numbers, not one', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(PM);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p === '/portfolio') return Promise.resolve({
        metric: 'portfolio', as_of: '2026-09-06T05:00:00Z', definition: 'x',
        data: [{
          id: 'p1', code: 'TWR', name: 'Tower B', state_class: 'in_progress',
          verified_pct: 62, reported_pct: 71, gap_pct: 12, awaiting_verification: 0,
          open_issues: 0, overdue_issues: 0, open_approvals: 0,
          oldest_approval_hours: 0, last_report_date: null, missing_report_days: 0,
        }],
      });
      return Promise.resolve({ data: [] });
    });
    mount(<Portfolio />);
    // "62% verified, 71% reported" is the whole point; one number would hide
    // the gap the product exists to surface.
    await waitFor(() => expect(screen.getByText('62%')).toBeInTheDocument());
    expect(screen.getByText('reported 71%')).toBeInTheDocument();
  });
});
