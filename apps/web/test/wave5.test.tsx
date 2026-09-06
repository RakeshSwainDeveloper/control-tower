/**
 * Wave 5 — approve.
 *
 * Two screens, one engine. The properties here are the ones that decide
 * whether an approval means anything: the approver can see what they are
 * approving without leaving the screen, a question keeps the clock running,
 * and refusing or asking both cost words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const { Approvals } = await import('../src/screens/office/Approvals.js');
const { ApprovalDecision } = await import('../src/screens/site/ApprovalDecision.js');

const PM: Me = {
  user_id: 'vikram', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: ['approval.task.decide', 'approval.instance.read', 'field.progress.read',
                'field.daily_report.read']
    .map((key) => ({ key, org_wide: false, project_ids: ['p1'],
                     qualifier: 'all_in_scope', responsibility: 'Project Manager' })),
};

const TASK = {
  task_id: 't1', project_id: 'p1', assigned_at: '2026-09-04T08:00:00Z',
  sla_due_at: '2026-09-05T08:00:00Z',
  instance_id: 'i1', object_type: 'daily_report', object_id: 'r1',
  submitted_at: '2026-09-04T08:00:00Z', submitted_by_name: 'Ramesh Kumar',
  submitted_responsibility: 'Site Supervisor',
  step_no: 1, step_name: 'Project Manager approval',
  project_code: 'TWR', project_name: 'Tower B',
  age_hours: 52, overdue: true,
};

const INBOX = { count: 1, oldest_age_hours: 52, overdue: 1, data: [TASK] };

const REPORT = {
  report: { id: 'r1', report_date: '2026-09-04', state_class: 'submitted',
            weather: 'Clear', notes: 'Pump repaired' },
  entries: [
    { id: 'e1', reported_qty: '12', verified_qty: '9', unit: 'sqm',
      work_item: 'Wall plaster 12mm', location: 'Flat 502', verification_status: 'adjusted' },
    { id: 'e2', reported_qty: '5', verified_qty: null, unit: 'm',
      work_item: 'Plumbing rough-in', location: 'Flat 101', verification_status: 'reported' },
  ],
};

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  localStorage.setItem('ct.project', 'p1');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(PM);
    if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
    if (p === '/me/approvals') return Promise.resolve(INBOX);
    if (p.includes('/daily-report')) return Promise.resolve(REPORT);
    if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
    if (p.includes('/trail')) return Promise.resolve({ instance: null, steps: [], decisions: [] });
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

describe('S-W06 approvals inbox', () => {
  it('puts the OLDEST AGE in front of the approver, not just a count', async () => {
    mount(<Approvals />);
    // A count says you have work. An age says you are the reason something is
    // stuck (MVP_SCREEN_LIST §2).
    await waitFor(() => expect(screen.getByText('oldest')).toBeInTheDocument());
    expect(screen.getByText('2 days')).toBeInTheDocument();
    expect(screen.getByText('past SLA')).toBeInTheDocument();
  });

  it('takes the ageing numbers from the SERVER, never deriving them', async () => {
    mount(<Approvals />);
    await screen.findByText('oldest');
    // 52 hours is what the server said. Deriving it client-side would
    // eventually disagree with the dashboard.
    expect(getMock).toHaveBeenCalledWith('/me/approvals');
  });

  it('decisions are taken inline — no page load per approval', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ decision: 'approve' });
    mount(<Approvals />);
    await user.click(await screen.findByRole('button', { name: /Daily report/ }));
    await user.click(await screen.findByRole('button', { name: /^Approve$/ }));
    await user.click(screen.getByRole('button', { name: /Record decision/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/approvals/t1/decide', { decision: 'approve' }));
  });

  it('a question and a rejection both cost words; approving does not', async () => {
    const user = userEvent.setup();
    mount(<Approvals />);
    await user.click(await screen.findByRole('button', { name: /Daily report/ }));

    await user.click(await screen.findByRole('button', { name: /Ask a question/ }));
    expect(screen.getByRole('button', { name: /Record decision/ })).toBeDisabled();
    // FR-201 stated where the approver reads it.
    expect(screen.getByText(/keeps ageing while you wait/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Comment'), 'Measured or estimated?');
    expect(screen.getByRole('button', { name: /Record decision/ })).toBeEnabled();
  });
});

describe('S-M13 approval decision', () => {
  it('renders the OBJECT on the page — no navigation to see what is being approved', async () => {
    mount(<ApprovalDecision />, '/site/approvals/t1', '/site/approvals/:taskId');
    await waitFor(() => expect(screen.getByText('The day being approved')).toBeInTheDocument());
    // The entries themselves, not a link to them.
    expect(screen.getByText('Wall plaster 12mm')).toBeInTheDocument();
    expect(screen.getByText('Plumbing rough-in')).toBeInTheDocument();
    expect(screen.getByText('Pump repaired')).toBeInTheDocument();
  });

  it('shows what was CONFIRMED next to what was claimed, and flags what was not', async () => {
    mount(<ApprovalDecision />, '/site/approvals/t1', '/site/approvals/:taskId');
    const row = (await screen.findByText('Wall plaster 12mm')).closest('li')!;
    expect(within(row).getByText(/confirmed 9/)).toBeInTheDocument();
    // The approver is signing off the day; an unverified entry is the thing
    // most worth seeing before they do.
    const other = screen.getByText('Plumbing rough-in').closest('li')!;
    expect(within(other).getByText('not verified')).toBeInTheDocument();
  });

  it('names who submitted it and in what capacity', async () => {
    mount(<ApprovalDecision />, '/site/approvals/t1', '/site/approvals/:taskId');
    await waitFor(() => expect(
      screen.getByText(/Ramesh Kumar as Site Supervisor/)).toBeInTheDocument());
  });

  it('says how long it has been waiting, and that it is late', async () => {
    mount(<ApprovalDecision />, '/site/approvals/t1', '/site/approvals/:taskId');
    // The age is computed from assigned_at at render time, so assert the shape
    // rather than a fixed number — pinning "52 hours" would make this test
    // start failing on its own on a date nobody chose.
    await waitFor(() => expect(screen.getByText(/Waiting \d+ hours/)).toBeInTheDocument());
    expect(screen.getByText(/past its SLA/)).toBeInTheDocument();
  });

  it('a task somebody else already decided says so instead of failing', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(PM);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p === '/me/approvals') return Promise.resolve({ count: 0, oldest_age_hours: 0, overdue: 0, data: [] });
      return Promise.resolve({ data: [] });
    });
    mount(<ApprovalDecision />, '/site/approvals/t1', '/site/approvals/:taskId');
    // Two approvers open the same item; one decides first. The other must get
    // an explanation, not a broken screen.
    await waitFor(() => expect(
      screen.getByText(/no longer waiting for you/i)).toBeInTheDocument());
  });
});
