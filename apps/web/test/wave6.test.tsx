/**
 * Wave 6 — issues.
 *
 * S-M10's gate is a measured 45 seconds, so the assertions are about what is
 * on the fast path and what is folded out of it. S-M11's are about the three
 * refusals being explained before they happen rather than after.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Me } from '../src/lib/session.js';

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api.js')>('../src/lib/api.js');
  return {
    ...actual,
    api: { get: (p: string) => getMock(p), post: (p: string, b: unknown) => postMock(p, b),
           patch: vi.fn(), del: vi.fn() },
    tokens: { ...actual.tokens, access: () => 'tok', refresh: () => 'ref' },
  };
});

const { SessionProvider } = await import('../src/lib/session.js');
const { RaiseIssue } = await import('../src/screens/site/RaiseIssue.js');
const { IssueDetail } = await import('../src/screens/site/IssueDetail.js');
const { IssueList } = await import('../src/screens/site/IssueList.js');
const outbox = await import('../src/lib/offline/outbox.js');

const ENGINEER: Me = {
  user_id: 'anita', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: ['issue.issue.create', 'issue.issue.read', 'issue.issue.resolve',
                'issue.issue.verify', 'issue.issue.close', 'issue.issue.reopen',
                'action.action.create', 'action.action.read']
    .map((key) => ({ key, org_wide: false, project_ids: ['p1'],
                     qualifier: 'all_in_scope', responsibility: 'Site Engineer' })),
};

const CATEGORIES = { data: [
  { id: 'c1', code: 'quality', name: 'Quality' },
  { id: 'c2', code: 'safety', name: 'Safety' },
  { id: 'c3', code: 'design', name: 'Design' },
] };
const LOCATIONS = { data: [
  { id: 'l1', parent_id: null, code: 'L5', name: 'Floor 5', level_name: 'Floor',
    display_path: 'Floor 5', depth: 1 },
  { id: 'l2', parent_id: 'l1', code: 'F502', name: 'Flat 502', level_name: 'Flat',
    display_path: 'Floor 5 › Flat 502', depth: 2 },
] };

const ISSUE = {
  id: 'i1', issue_number: 'ISS/TWR/2026-27/0001', title: 'Honeycombing on column C4',
  description: 'Voids around the base', severity: 'medium', state_class: 'in_progress',
  category: 'Quality', location: 'Floor 5 › Flat 502', assignee: null, due_date: null,
  raised_at: '2026-09-06T02:00:00Z', raised_responsibility: 'Site Supervisor',
  resolved_at: null, verified_at: null, closed_at: null, reopen_count: 0,
};

beforeEach(async () => {
  getMock.mockReset(); postMock.mockReset();
  localStorage.clear();
  localStorage.setItem('ct.project', 'p1');
  const d = await outbox.db();
  await d.clear('outbox'); await d.clear('blobs'); await d.clear('cache');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(ENGINEER);
    if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
    if (p.includes('master-data')) return Promise.resolve(CATEGORIES);
    if (p.includes('/locations')) return Promise.resolve(LOCATIONS);
    if (p.includes('/members')) return Promise.resolve({ data: [{ user_id: 'u9', name: 'Suresh' }] });
    if (p.includes('/issues')) return Promise.resolve({ data: [ISSUE] });
    if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
    if (p.includes('/comments')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});

const mount = (ui: React.ReactNode, path = '/', pattern = '/') => render(
  <SessionProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path={pattern} element={ui} /></Routes>
    </MemoryRouter>
  </SessionProvider>,
);

describe('S-M10 raise an issue', () => {
  it('puts category and severity on the fast path as CHIPS, not dropdowns', async () => {
    mount(<RaiseIssue />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quality' })).toBeInTheDocument());
    for (const s of ['Low', 'Medium', 'High', 'Critical']) {
      expect(screen.getByRole('button', { name: s })).toBeInTheDocument();
    }
  });

  it('folds assignee, due date and description OUT of the 45 seconds', async () => {
    const user = userEvent.setup();
    mount(<RaiseIssue />);
    await screen.findByRole('button', { name: 'Quality' });
    // Not on the page until asked for.
    expect(screen.queryByLabelText('Who should fix it')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Assign it, or add more detail/ }));
    expect(await screen.findByLabelText('Who should fix it')).toBeInTheDocument();
  });

  it('warns BEFORE submission that high and critical need an approval to close', async () => {
    const user = userEvent.setup();
    mount(<RaiseIssue />);
    await user.click(await screen.findByRole('button', { name: 'Critical' }));
    // Discovered at raising time, not at closing time three weeks later.
    expect(screen.getByText(/need an approval to close/)).toBeInTheDocument();
  });

  it('queues the issue on the DEVICE — raising never depends on the network', async () => {
    const user = userEvent.setup();
    mount(<RaiseIssue />);
    await user.type(await screen.findByLabelText('What is wrong'), 'Honeycombing on column C4');
    await user.click(screen.getByRole('button', { name: 'Quality' }));
    await user.click(screen.getByRole('button', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: /RAISE IT/ }));

    await waitFor(() => expect(screen.getByText('Raised')).toBeInTheDocument());
    const queued = await outbox.all();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.entity).toBe('issue');
    expect(queued[0]!.payload['severity']).toBe('high');
    expect(queued[0]!.payload['category_code']).toBe('quality');
    // No direct POST — nothing could have failed for want of signal.
    expect(postMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/issues'), expect.anything());
  });

  it('will not raise an issue with no description of what is wrong', async () => {
    mount(<RaiseIssue />);
    expect(await screen.findByRole('button', { name: /RAISE IT/ })).toBeDisabled();
  });
});

describe('S-M11 issue detail', () => {
  it('demands a photograph BEFORE offering to resolve', async () => {
    mount(<IssueDetail />, '/site/issues/i1', '/site/issues/:issueId');
    await waitFor(() => expect(
      screen.getByText(/resolved with no photo is a claim/)).toBeInTheDocument());
    // The resolve control is not offered until there is evidence.
    expect(screen.queryByRole('button', { name: /Mark it resolved/ })).toBeNull();
    expect(screen.getByText(/Add the photo/)).toBeInTheDocument();
  });

  it('explains SoD-03 at the point of verification', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/issues')) return Promise.resolve({ data: [{ ...ISSUE, state_class: 'resolved', resolved_at: '2026-09-06T03:00:00Z' }] });
      if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mount(<IssueDetail />, '/site/issues/i1', '/site/issues/:issueId');
    await waitFor(() => expect(screen.getByText(/SoD-03/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Verify it/ })).toBeInTheDocument();
  });

  it('blocks closure while a question is unanswered, and says why', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/issues')) return Promise.resolve({ data: [{ ...ISSUE, state_class: 'verified' }] });
      if (p.includes('/comments')) return Promise.resolve({ data: [{
        id: 'c1', body: 'Same M30 mix?', is_query: true, created_at: '2026-09-06T03:00:00Z',
        author: 'Vikram Shah', author_responsibility: 'Project Manager',
        addressed_to: 'anita', answer_body: null, answered_at: null, answered_by_name: null,
      }] });
      if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mount(<IssueDetail />, '/site/issues/i1', '/site/issues/:issueId');
    await waitFor(() => expect(
      screen.getByText(/unanswered question on this issue/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Close it/ })).toBeDisabled();
  });

  it('shows the reopen count, because a defect fixed three times is a different story', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/issues')) return Promise.resolve({ data: [{ ...ISSUE, reopen_count: 3 }] });
      if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mount(<IssueDetail />, '/site/issues/i1', '/site/issues/:issueId');
    await waitFor(() => expect(screen.getByText('Reopened 3×')).toBeInTheDocument());
  });
});

describe('S-M12 issue list', () => {
  it('opens on what is OPEN, not on everything ever raised', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/issues')) return Promise.resolve({ data: [
        ISSUE,
        { ...ISSUE, id: 'i2', title: 'Old closed thing', state_class: 'closed' },
      ] });
      return Promise.resolve({ data: [] });
    });
    mount(<IssueList />, '/site/issues', '/site/issues');
    await waitFor(() => expect(screen.getByText('Honeycombing on column C4')).toBeInTheDocument());
    // A list that opens on 400 closed issues buries the eleven that are not.
    expect(screen.queryByText('Old closed thing')).toBeNull();
    expect(screen.getByRole('button', { name: /Show 1 closed/ })).toBeInTheDocument();
  });

  it('keeps filters in the URL so a view can be sent as a link', async () => {
    const user = userEvent.setup();
    mount(<IssueList />, '/site/issues', '/site/issues');
    await user.click(await screen.findByRole('button', { name: 'Critical' }));
    await waitFor(() => expect(
      getMock.mock.calls.some(([p]) => String(p).includes('severity=critical'))).toBe(true));
  });
});
