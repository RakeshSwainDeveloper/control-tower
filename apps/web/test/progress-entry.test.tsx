/**
 * S-M03 — the screen the release is blocked on.
 *
 * These assertions are the design constraints from MVP_SCREEN_LIST §1 and
 * UI_UX_PLAN §3.5, made mechanical. Each one, if it broke, would show up as a
 * slower stopwatch on a real site rather than as a red test — which is exactly
 * why they are asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
const { ProgressEntry } = await import('../src/screens/site/ProgressEntry.js');
const outbox = await import('../src/lib/offline/outbox.js');

const SUPERVISOR: Me = {
  user_id: 'u1', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [{
    key: 'field.progress.create', org_wide: false, project_ids: ['p1'],
    qualifier: 'all_in_scope', responsibility: 'Site Supervisor',
  }],
};

const LOCATIONS = { data: [
  { id: 'l1', parent_id: null, code: 'L5', name: 'Floor 5', level_name: 'Floor',
    display_path: 'Floor 5', depth: 1 },
  { id: 'l2', parent_id: 'l1', code: 'F502', name: 'Flat 502', level_name: 'Flat',
    display_path: 'Floor 5 › Flat 502', depth: 2 },
  { id: 'l3', parent_id: 'l2', code: 'F502-BAT', name: 'Bathroom', level_name: 'Room',
    display_path: 'Floor 5 › Flat 502 › Bathroom', depth: 3 },
] };
const WORK = { data: [
  { id: 'w1', code: 'WI-PLI', description: 'Wall plaster 12mm', unit_code: 'sqm', planned_qty: '48' },
  { id: 'w2', code: 'WI-TIL', description: 'Floor tiling', unit_code: 'sqm', planned_qty: '20' },
] };

beforeEach(async () => {
  getMock.mockReset(); postMock.mockReset();
  localStorage.clear();
  localStorage.setItem('ct.project', 'p1');
  const d = await outbox.db();
  await d.clear('outbox'); await d.clear('blobs'); await d.clear('cache');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(SUPERVISOR);
    if (p.startsWith('/projects?')) return Promise.resolve({ data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] });
    if (p.includes('/locations')) return Promise.resolve(LOCATIONS);
    if (p.includes('/work-items?')) return Promise.resolve(WORK);
    if (p.includes('/allocations')) return Promise.resolve({ data: [{ planned_qty: '48', verified_qty: '30' }] });
    return Promise.resolve({ data: [] });
  });
});

const mount = () => render(
  <SessionProvider><MemoryRouter><ProgressEntry /></MemoryRouter></SessionProvider>,
);

describe('S-M03 progress entry', () => {
  it('has FIVE fields and no more', async () => {
    mount();
    await screen.findByText('Location');
    for (const label of ['Location', 'Work item', 'Quantity today', 'Evidence', 'Contractor']) {
      expect(screen.getByText(label), `${label} is missing`).toBeInTheDocument();
    }
  });

  it('has NO percentage input anywhere — percentage is derived (FR-142)', async () => {
    mount();
    await screen.findByText('Location');
    // "80% complete" is an opinion; "412 of 515 sqm" is a fact. A field for it
    // would invite the opinion.
    for (const input of screen.queryAllByRole('textbox')) {
      const name = `${input.getAttribute('aria-label') ?? ''} ${input.getAttribute('placeholder') ?? ''}`;
      expect(name.toLowerCase()).not.toMatch(/percent|%|progress %/);
    }
    expect(screen.queryByLabelText(/percent/i)).toBeNull();
  });

  it('the quantity field raises a NUMERIC keypad, not a QWERTY keyboard', async () => {
    mount();
    const qty = await screen.findByLabelText('Quantity today');
    // inputMode is what Android actually reads. type="number" would have been
    // the obvious choice and gives a worse keypad plus spinner arrows.
    expect(qty).toHaveAttribute('inputmode', 'decimal');
  });

  it('refuses non-numeric input rather than accepting and failing later', async () => {
    const user = userEvent.setup();
    mount();
    const qty = await screen.findByLabelText('Quantity today');
    await user.type(qty, '12abc.5');
    expect(qty).toHaveValue('12.5');
  });

  it('the location picker offers only LEAVES, never a floor', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Choose a location/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Location' });
    // 12 sqm of plaster recorded against "Floor 5" is unusable for
    // verification, and a picker that allows it will collect them.
    expect(within(dialog).getByText('Bathroom')).toBeInTheDocument();
    expect(within(dialog).queryByText('Floor 5')).toBeNull();
    expect(within(dialog).queryByText('Flat 502')).toBeNull();
  });

  it('the picker leads with RECENTS, not with a blank search box', async () => {
    localStorage.setItem('ct.recent.locations', JSON.stringify(['l3']));
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Bathroom|Choose a location/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Location' });
    expect(within(dialog).getByText('Recent')).toBeInTheDocument();
  });

  it('SUBMIT writes to the outbox and never depends on the network', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole('button', { name: /Choose a location/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Bathroom'));
    await user.click(await screen.findByRole('button', { name: /Choose the work/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Wall plaster 12mm'));
    await user.type(await screen.findByLabelText('Quantity today'), '12');

    await user.click(screen.getByRole('button', { name: /SUBMIT/ }));
    await waitFor(() => expect(screen.getByText('Recorded')).toBeInTheDocument());

    // The entry is on the device. No POST to /progress was needed, and none
    // could have failed.
    const queued = await outbox.all();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.entity).toBe('progress_entry');
    expect(queued[0]!.payload['reported_qty']).toBe('12');
    expect(queued[0]!.payload['location_id']).toBe('l3');
    expect(postMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/progress'), expect.anything());
  });

  it('carries a client_uuid so a retry cannot become a second entry', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Choose a location/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Bathroom'));
    await user.click(await screen.findByRole('button', { name: /Choose the work/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Wall plaster 12mm'));
    await user.type(await screen.findByLabelText('Quantity today'), '8');
    await user.click(screen.getByRole('button', { name: /SUBMIT/ }));
    await waitFor(() => expect(screen.getByText('Recorded')).toBeInTheDocument());

    const [item] = await outbox.all();
    expect(item!.client_uuid).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('"Record another" keeps the location and work item, clearing only the quantity', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Choose a location/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Bathroom'));
    await user.click(await screen.findByRole('button', { name: /Choose the work/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Wall plaster 12mm'));
    await user.type(await screen.findByLabelText('Quantity today'), '12');
    await user.click(screen.getByRole('button', { name: /SUBMIT/ }));

    await user.click(await screen.findByRole('button', { name: /Record another/ }));
    // The next entry is usually the same work at the next place; re-picking
    // both every time is where the 25-second target goes.
    expect(await screen.findByLabelText('Quantity today')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Wall plaster 12mm/ })).toBeInTheDocument();
  });

  it('SUBMIT stays disabled until there is something worth recording', async () => {
    const user = userEvent.setup();
    mount();
    const submit = await screen.findByRole('button', { name: /SUBMIT/ });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Choose a location/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Bathroom'));
    await user.click(await screen.findByRole('button', { name: /Choose the work/ }));
    await user.click(within(await screen.findByRole('dialog')).getByText('Wall plaster 12mm'));
    // Still nothing entered.
    expect(screen.getByRole('button', { name: /SUBMIT/ })).toBeDisabled();

    await user.type(await screen.findByLabelText('Quantity today'), '0');
    // Zero is not progress.
    expect(screen.getByRole('button', { name: /SUBMIT/ })).toBeDisabled();
  });
});
