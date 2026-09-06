/**
 * "A user never sees a tile or action they cannot use."
 *
 * This is the rule that makes the site surface usable: a supervisor's Today
 * screen has four tiles and a project manager's has nine, and neither is shown
 * a control that will refuse them. It is presentation only — the server
 * enforces regardless (FR-564) — but a leak means a site engineer taps
 * Approve, gets a 403, and stops trusting the app.
 *
 * The scoping cases matter most: a grant on Tower A must not light up a button
 * on Tower B.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Me } from '../src/lib/session.js';

const getMock = vi.fn();
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api.js')>('../src/lib/api.js');
  return {
    ...actual,
    api: { get: (p: string) => getMock(p), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
    tokens: { ...actual.tokens, access: () => 'test-token', refresh: () => 'test-refresh' },
  };
});

const { SessionProvider, useSession } = await import('../src/lib/session.js');
const { Can } = await import('../src/components/Gate.js');

const ME: Me = {
  user_id: 'u1', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [
    { key: 'field.progress.create', org_wide: false, project_ids: ['tower-a'],
      qualifier: 'all_in_scope', responsibility: 'Site Supervisor' },
    { key: 'issue.issue.read', org_wide: true, project_ids: [],
      qualifier: 'all_in_scope', responsibility: 'Project Manager' },
  ],
};

function Probe() {
  const { can, responsibilityFor } = useSession();
  return (
    <ul>
      <li>a:{String(can('field.progress.create', 'tower-a'))}</li>
      <li>b:{String(can('field.progress.create', 'tower-b'))}</li>
      <li>org:{String(can('issue.issue.read', 'tower-b'))}</li>
      <li>none:{String(can('approval.task.decide', 'tower-a'))}</li>
      <li>resp:{responsibilityFor('field.progress.create')}</li>
    </ul>
  );
}

describe('permission gating', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockImplementation((path: string) =>
      path === '/auth/me' ? Promise.resolve(ME) : Promise.resolve({ data: [] }));
  });

  it('grants on the project it was scoped to, and NOT on another', async () => {
    render(<SessionProvider><Probe /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('a:true')).toBeInTheDocument());
    // The whole point of project-scoped grants.
    expect(screen.getByText('b:false')).toBeInTheDocument();
  });

  it('an org-wide grant applies to every project', async () => {
    render(<SessionProvider><Probe /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('org:true')).toBeInTheDocument());
  });

  it('a key the user does not hold at all is false', async () => {
    render(<SessionProvider><Probe /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('none:false')).toBeInTheDocument());
  });

  it('carries the responsibility label the server will stamp on the record', async () => {
    // FR-030: "Ramesh recorded this as Site Supervisor". The UI shows the same
    // words before submission that the audit trail will show after it.
    render(<SessionProvider><Probe /></SessionProvider>);
    await waitFor(() => expect(screen.getByText('resp:Site Supervisor')).toBeInTheDocument());
  });

  it('<Can> HIDES rather than disables (and its prop is `perm`, not `key`)', async () => {
    render(
      <SessionProvider>
        <Can perm="approval.task.decide" projectId="tower-a"><button>Approve</button></Can>
        <Can perm="issue.issue.read" projectId="tower-a"><button>Issues</button></Can>
      </SessionProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Issues' })).toBeInTheDocument());
    // Not "present but disabled" — absent. A greyed-out control teaches a site
    // engineer that the product is refusing them, and they ask the PM why.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
