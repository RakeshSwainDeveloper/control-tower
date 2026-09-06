/**
 * The routes actually mount.
 *
 * A 200 from the dev server proves nginx serves index.html and nothing else —
 * an SPA returns 200 for a route that throws on render. These tests mount the
 * real route table and assert what a person would see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { Me } from '../src/lib/session.js';

const getMock = vi.fn();
const postMock = vi.fn();
let hasToken = true;

vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api.js')>('../src/lib/api.js');
  return {
    ...actual,
    api: { get: (p: string) => getMock(p), post: (p: string, b: unknown) => postMock(p, b),
           patch: vi.fn(), del: vi.fn() },
    tokens: {
      ...actual.tokens,
      access: () => (hasToken ? 'tok' : null),
      refresh: () => (hasToken ? 'ref' : null),
    },
  };
});

const { routes } = await import('../src/routes.js');
const { SessionProvider } = await import('../src/lib/session.js');

const PM: Me = {
  user_id: 'u1', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [
    { key: 'report.dashboard.read', org_wide: true, project_ids: [], qualifier: 'all_in_scope', responsibility: 'Project Manager' },
    { key: 'org.user.read', org_wide: true, project_ids: [], qualifier: 'all_in_scope', responsibility: 'Project Manager' },
    { key: 'org.role.read', org_wide: true, project_ids: [], qualifier: 'all_in_scope', responsibility: 'Project Manager' },
    { key: 'issue.issue.read', org_wide: true, project_ids: [], qualifier: 'all_in_scope', responsibility: 'Project Manager' },
  ],
};

const SUPERVISOR: Me = {
  user_id: 'u2', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [
    { key: 'field.progress.create', org_wide: false, project_ids: ['p1'], qualifier: 'all_in_scope', responsibility: 'Site Supervisor' },
  ],
};

const PROJECTS = { data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] };

function mount(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<SessionProvider><RouterProvider router={router} /></SessionProvider>);
}

function signedInAs(me: Me | null) {
  hasToken = me !== null;
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return me ? Promise.resolve(me) : Promise.reject(new Error('401'));
    if (p.startsWith('/projects')) return Promise.resolve(PROJECTS);
    return Promise.resolve({ data: [] });
  });
}

describe('routing', () => {
  beforeEach(() => { getMock.mockReset(); postMock.mockReset(); });

  it('S-W01 renders the office sign-in form', async () => {
    signedInAs(null);
    mount('/login');
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('S-M01 asks for a phone number, NOT a password', async () => {
    signedInAs(null);
    mount('/site/login');
    await waitFor(() => expect(screen.getByLabelText('Mobile number')).toBeInTheDocument());
    // A site supervisor on a shared handset must never be asked for a password.
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('an unauthenticated visit to a site route lands on the SITE sign-in, not the office one', async () => {
    signedInAs(null);
    mount('/site');
    await waitFor(() => expect(screen.getByLabelText('Mobile number')).toBeInTheDocument());
  });

  it('the office shell draws only the nav a project manager can open', async () => {
    signedInAs(PM);
    mount('/office');
    await waitFor(() => expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Users & roles/ })).toBeInTheDocument();
    // No project.project.update grant, so no Project setup entry — hidden,
    // not disabled.
    expect(screen.queryByRole('link', { name: /Project setup/ })).toBeNull();
    // No audit.log.read either.
    expect(screen.queryByRole('link', { name: /Audit/ })).toBeNull();
  });

  it('the site shell shows a supervisor three tabs, not four', async () => {
    signedInAs(SUPERVISOR);
    mount('/site');
    await waitFor(() => expect(screen.getByRole('link', { name: /Today/ })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /My Work/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Profile/ })).toBeInTheDocument();
    // No issue.issue.read grant.
    expect(screen.queryByRole('link', { name: /Issues/ })).toBeNull();
  });

  it('/ sends a supervisor to the site and a manager to the office', async () => {
    signedInAs(SUPERVISOR);
    mount('/');
    await waitFor(() => expect(screen.getByRole('link', { name: /Today/ })).toBeInTheDocument());

    signedInAs(PM);
    mount('/');
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Dashboard/ })[0]).toBeInTheDocument());
  });

  it('S-M16 refuses to clear local data while work is unsent', async () => {
    signedInAs(SUPERVISOR);
    const outbox = await import('../src/lib/offline/outbox.js');
    const d = await outbox.db();
    await d.clear('outbox');
    await outbox.enqueue({ entity: 'progress_entry', payload: {}, label: 'Wall plaster' });

    mount('/site/me');
    const btn = await screen.findByRole('button', { name: /Clear downloaded data/ });
    // A supervisor tapping this with unsent work would lose their morning.
    await waitFor(() => expect(btn).toBeDisabled());
    await d.clear('outbox');
  });
});
