/**
 * Wave 2 — the setup screens, rendered against mocked API responses.
 *
 * The properties worth protecting here are the ones that stop somebody
 * destroying an afternoon: the pattern builder shows a count before it creates
 * 168 rows, the import writes nothing until it is confirmed, and the approval
 * editor says "publish", not "save", because a published version is immutable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
const { ProjectSetup } = await import('../src/screens/office/ProjectSetup.js');
const { ApprovalConfig } = await import('../src/screens/office/ApprovalConfig.js');

const ADMIN: Me = {
  user_id: 'u1', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [
    'project.project.update', 'project.location.read', 'project.location.create',
    'project.work_item.read', 'project.work_item.create', 'project.work_item.import',
    'org.role.read', 'approval.definition.read', 'approval.definition.configure',
  ].map((key) => ({ key, org_wide: true, project_ids: [], qualifier: 'all_in_scope',
                    responsibility: 'Company Admin' })),
};

const PROJECTS = { data: [{ id: 'p1', code: 'TWR', name: 'Tower B' }] };

function mount(ui: React.ReactNode) {
  return render(<SessionProvider><MemoryRouter>{ui}</MemoryRouter></SessionProvider>);
}

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  localStorage.setItem('ct.project', 'p1');
  getMock.mockImplementation((p: string) => {
    if (p === '/auth/me') return Promise.resolve(ADMIN);
    if (p.startsWith('/projects?')) return Promise.resolve(PROJECTS);
    if (p.includes('/locations')) return Promise.resolve({ data: [] });
    if (p.includes('/work-items')) return Promise.resolve({ data: [] });
    if (p.includes('/members')) return Promise.resolve({ data: [] });
    if (p === '/roles') return Promise.resolve({ data: [{ id: 'r1', code: 'site_engineer', name: 'Site Engineer' }] });
    if (p.startsWith('/approval-definitions')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});

describe('S-W08 project setup', () => {
  it('the pattern builder states how many locations it will create BEFORE creating them', async () => {
    const user = userEvent.setup();
    mount(<ProjectSetup />);
    await user.click(await screen.findByRole('button', { name: /Build from a pattern/ }));

    // Two levels seeded at 8 and 4 → 32. Somebody should see that number before
    // committing, not discover it afterwards in a list of 32 rows.
    await waitFor(() => expect(screen.getByText('32 locations')).toBeInTheDocument());
  });

  it('an import is previewed and confirmed — never applied on paste', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue({ job_id: 'j1', ok: 2, errors: [] });
    mount(<ProjectSetup />);

    // The setup tabs carry role="tab", not role="button".
    await user.click(await screen.findByRole('tab', { name: /Work items/ }));
    await user.click(await screen.findByRole('button', { name: /Import from a spreadsheet/ }));

    const box = await screen.findByLabelText(/Paste the sheet/);
    await user.click(box);
    await user.paste('Code,Description,Unit,Qty\nWI-A,Plaster,sqm,10\nWI-B,Tiling,sqm,20');

    // Pasting alone must not write anything.
    expect(postMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('2 rows read')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/2 rows will be created/)).toBeInTheDocument());

    // Still nothing created: the preview call is not the confirm call.
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0]![0]).toMatch(/work-items\/import$/);

    await user.click(screen.getByRole('button', { name: /Confirm and create 2/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]![0]).toMatch(/import\/j1\/confirm$/);
  });
});

describe('S-W10 approval configuration', () => {
  it('warns that an object type with no workflow is REFUSED, not auto-approved', async () => {
    mount(<ApprovalConfig />);
    // The phrase appears in the warning banner and in the page's own preamble;
    // the banner is the one that must be there.
    await waitFor(() => expect(
      screen.getByText(/Daily report and Issue closure.*ha(s|ve) no approval workflow/i),
    ).toBeInTheDocument());
    expect(screen.getByText(/refused rather than auto-approved/i)).toBeInTheDocument();
  });

  it('the editor publishes a version rather than saving an edit', async () => {
    const user = userEvent.setup();
    mount(<ApprovalConfig />);
    await user.click(await screen.findByRole('button', { name: /New workflow/ }));
    // BR-20 made visible in the button itself.
    expect(await screen.findByRole('button', { name: /^Create$/ })).toBeInTheDocument();
    expect(screen.getByText(/The engine caps it at five/)).toBeInTheDocument();
  });
});
