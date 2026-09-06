/**
 * Wave 4 — verify and report.
 *
 * The properties asserted here are the ones the product's credibility rests
 * on: the gap between what site claims and what was confirmed must stay
 * visible, an adjustment must never be presented as correcting the claim, and
 * nobody must be invited to sign off their own work.
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
const { Verify } = await import('../src/screens/site/Verify.js');
const { MyWork } = await import('../src/screens/site/MyWork.js');
const { DailyReport } = await import('../src/screens/site/DailyReport.js');
const { Workbench } = await import('../src/screens/office/Workbench.js');

const ENGINEER: Me = {
  user_id: 'anita', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: ['field.progress.create', 'field.progress.verify', 'field.progress.read',
                'field.daily_report.create', 'field.daily_report.submit']
    .map((key) => ({ key, org_wide: false, project_ids: ['p1'],
                     qualifier: 'all_in_scope', responsibility: 'Site Engineer' })),
};

const ENTRY = {
  id: 'e1', reported_qty: '12.0000', verified_qty: null, verification_status: 'reported',
  verification_reason: null, unit: 'sqm', work_item: 'Wall plaster 12mm',
  work_item_code: 'WI-PLI', location: 'Floor 5 › Flat 502 › Bathroom',
  contractor_label: 'Sharma & Co', note: null,
  reported_at: '2026-09-06T02:00:00Z', reported_by: 'ramesh',
  reported_by_name: 'Ramesh Kumar', reported_responsibility: 'Site Supervisor',
  verified_by_name: null, verified_responsibility: null, is_over_execution: false,
};

const GAP = {
  metric: 'reported_vs_verified_gap', value: 100, unit: 'percent',
  as_of: '2026-09-06T04:00:00Z',
  definition: 'Sum of reported quantity minus sum of verified quantity, over sum of reported.',
  breakdown: { reported_total: 12, verified_total: 0, variance: -12, entries: 1,
               verified_entries: 0, awaiting_verification: 1, adjusted: 0, rejected: 0,
               over_execution: 0 },
  drill: { endpoint: '/api/v1/projects/p1/progress', params: {} },
};

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  localStorage.setItem('ct.project', 'p1');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(ENGINEER);
    if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
    if (p.includes('/verification-gap')) return Promise.resolve(GAP);
    if (p.includes('/progress')) return Promise.resolve({ data: [ENTRY] });
    if (p.includes('/daily-report')) return Promise.resolve({ date: '2026-09-06', report: null, locked: false, entries: [] });
    if (p.startsWith('/evidence')) return Promise.resolve({ data: [] });
    if (p.startsWith('/me/work')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});

const mountAt = (path: string, element: React.ReactNode, pattern: string) => render(
  <SessionProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path={pattern} element={element} /></Routes>
    </MemoryRouter>
  </SessionProvider>,
);

describe('S-M09 verification', () => {
  it('shows the claim, who made it, and in what capacity', async () => {
    mountAt('/site/verify/e1', <Verify />, '/site/verify/:entryId');
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
    // FR-030: who acted is half the fact; in what capacity is the other half.
    expect(screen.getByText(/Ramesh Kumar as Site Supervisor/)).toBeInTheDocument();
  });

  it('an ADJUSTMENT is presented as disagreement, not as correcting the claim', async () => {
    const user = userEvent.setup();
    mountAt('/site/verify/e1', <Verify />, '/site/verify/:entryId');
    await user.click(await screen.findByRole('button', { name: /Adjust/ }));
    // Change C-3. If the screen said "correct the quantity", the gap the whole
    // product exists to surface would read as an error being fixed.
    expect(await screen.findByText(/claim is\s+kept as it was recorded/i)).toBeInTheDocument();
  });

  it('adjusting and rejecting both demand a reason; accepting does not', async () => {
    const user = userEvent.setup();
    mountAt('/site/verify/e1', <Verify />, '/site/verify/:entryId');

    await user.click(await screen.findByRole('button', { name: /Accept/ }));
    expect(screen.getByRole('button', { name: /ACCEPT THE CLAIM/ })).toBeEnabled();
    expect(screen.queryByLabelText('Reason')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Reject/ }));
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /REJECT/ })).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Not done');
    expect(screen.getByRole('button', { name: /REJECT/ })).toBeEnabled();
  });

  it('SoD-02: somebody looking at their OWN claim is not offered the controls', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/progress')) return Promise.resolve({ data: [{ ...ENTRY, reported_by: 'anita' }] });
      return Promise.resolve({ data: [] });
    });
    mountAt('/site/verify/e1', <Verify />, '/site/verify/:entryId');
    // The server refuses it regardless. Hiding the controls means the engineer
    // is never invited to do something and then told no.
    await waitFor(() => expect(screen.getByText(/You recorded this yourself/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.getByText(/SoD-02/)).toBeInTheDocument();
  });
});

describe('S-W04 workbench', () => {
  it('keeps the reported-vs-verified GAP permanently in view', async () => {
    mountAt('/office/progress', <Workbench />, '/office/progress');
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    expect(screen.getByText(/reported but not yet verified/)).toBeInTheDocument();
    // FR-522: the number states what it counts and when it was computed.
    expect(screen.getByText(/Sum of reported quantity minus/)).toBeInTheDocument();
  });

  it('shows claimed and confirmed as two numbers, never one replacing the other', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/verification-gap')) return Promise.resolve(GAP);
      if (p.includes('/progress')) return Promise.resolve({ data: [{
        ...ENTRY, verified_qty: '9.0000', verification_status: 'adjusted',
        verification_reason: 'Measured 9 sqm on site', verified_by_name: 'Anita Desai',
        verified_responsibility: 'Site Engineer',
      }] });
      return Promise.resolve({ data: [] });
    });
    mountAt('/office/progress', <Workbench />, '/office/progress');
    // "12" also appears in the gap tiles above, so scope to the row.
    const row = (await screen.findByText('Wall plaster 12mm')).closest('li')!;
    await waitFor(() => expect(within(row).getByText('12')).toBeInTheDocument());
    expect(within(row).getByText(/confirmed 9/)).toBeInTheDocument();
    // The difference, signed, so a reader does not have to subtract.
    expect(screen.getByText(/\(−3\)/)).toBeInTheDocument();
  });
});

describe('S-M07 daily report', () => {
  it('refuses to submit a day with nothing recorded', async () => {
    mountAt('/site/report', <DailyReport />, '/site/report');
    const submit = await screen.findByRole('button', { name: /SUBMIT THE DAY/ });
    // A report with no entries says nothing, and submitting one teaches a
    // supervisor that the form is a formality.
    expect(submit).toBeDisabled();
    expect(screen.getByText(/A report with no entries says nothing/)).toBeInTheDocument();
  });

  it('does not ask the supervisor to re-enter what they already recorded', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.includes('/daily-report')) return Promise.resolve({
        date: '2026-09-06', report: null, locked: false,
        entries: [{ id: 'e1', reported_qty: '12', unit: 'sqm', work_item: 'Wall plaster 12mm',
                    location: 'Flat 502', verification_status: 'reported' }],
      });
      return Promise.resolve({ data: [] });
    });
    mountAt('/site/report', <DailyReport />, '/site/report');
    await waitFor(() => expect(screen.getByText('Wall plaster 12mm')).toBeInTheDocument());
    // Weather is the only decision. Everything else is already there.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SUBMIT THE DAY/ })).toBeEnabled();
  });
});

describe('S-M08 My Work', () => {
  it('is ONE list, and says so when it is empty', async () => {
    mountAt('/site/work', <MyWork />, '/site/work');
    await waitFor(() => expect(
      screen.getByText(/Nothing is waiting for you/)).toBeInTheDocument());
  });

  it('marks what is late and puts the words in the row', async () => {
    getMock.mockImplementation((p: string) => {
      if (p === '/auth/me') return Promise.resolve(ENGINEER);
      if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
      if (p.startsWith('/me/work')) return Promise.resolve({ data: [
        { kind: 'approval', id: 'a1', project_id: 'p1', title: 'Approve daily_report DR-1',
          due_date: '2026-09-01', created_at: '2026-08-30T00:00:00Z',
          needs_acceptance: false, overdue: true },
        { kind: 'task', id: 't1', project_id: 'p1', title: 'Re-check C4',
          due_date: null, created_at: '2026-09-05T00:00:00Z',
          needs_acceptance: false, overdue: false },
      ] });
      return Promise.resolve({ data: [] });
    });
    mountAt('/site/work', <MyWork />, '/site/work');
    await waitFor(() => expect(screen.getByText('1 late')).toBeInTheDocument());
    expect(screen.getByText(/days late/)).toBeInTheDocument();
    // Mixed kinds in one list — the point of change C-4.
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('Task assigned to you')).toBeInTheDocument();
  });
});
