/**
 * The public landing page.
 *
 * Two things this must never do: appear for a signed-in user (they asked for
 * the app, not the pitch), and claim something the product does not do. The
 * copy assertions below are deliberate — they pin the page to the vocabulary
 * the application actually uses, so a marketing edit that drifts from the
 * product fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Me } from '../src/lib/session.js';

const getMock = vi.fn();
let hasToken = false;
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api.js')>('../src/lib/api.js');
  return {
    ...actual,
    api: { get: (p: string) => getMock(p), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
    tokens: {
      ...actual.tokens,
      access: () => (hasToken ? 'tok' : null),
      refresh: () => (hasToken ? 'ref' : null),
    },
  };
});

const { SessionProvider } = await import('../src/lib/session.js');
const { RootRedirect } = await import('../src/screens/RootRedirect.js');
const { Landing } = await import('../src/screens/landing/Landing.js');
const { BuildingScene, STAGES } = await import('../src/screens/landing/BuildingScene.js');

const SUPERVISOR: Me = {
  user_id: 'u1', org_id: 'o1', permission_version: 1, catalogue_size: 52,
  permissions: [{ key: 'field.progress.create', org_wide: false, project_ids: ['p1'],
                  qualifier: 'all_in_scope', responsibility: 'Site Supervisor' }],
};

const mount = (ui: React.ReactNode) => render(
  <SessionProvider><MemoryRouter>{ui}</MemoryRouter></SessionProvider>,
);

beforeEach(() => {
  getMock.mockReset();
  hasToken = false;
  getMock.mockImplementation((p: string) =>
    p === '/auth/me' ? Promise.resolve(SUPERVISOR) : Promise.resolve({ data: [] }));
});

describe('landing page', () => {
  it('a signed-out visitor at / gets the landing page, not a login redirect', async () => {
    mount(<RootRedirect />);
    await waitFor(() => expect(
      screen.getByRole('heading', { level: 1 })).toBeInTheDocument());
    expect(screen.getAllByRole('link', { name: /sign in/i }).length).toBeGreaterThan(0);
  });

  it('a signed-in user never sees it — they asked for the app', async () => {
    hasToken = true;
    mount(<RootRedirect />);
    // Redirects to the site surface; nothing of the landing page renders.
    await waitFor(() => expect(screen.queryByText(/Construction project control/i)).toBeNull());
  });

  it('the hero states the promise the product is built around', async () => {
    mount(<Landing />);
    const h1 = screen.getByRole('heading', { level: 1 });
    // "Know what is happening… what has actually been verified… what needs you."
    expect(h1).toHaveTextContent(/happening on every site/i);
    expect(h1).toHaveTextContent(/verified/i);
  });

  it('every story section maps to a screen that exists', () => {
    mount(<Landing />);
    // Scoped to the kicker element: "Evidence" is also the title of a mock
    // panel further down, which is the point — the section and the screen it
    // describes use the same word.
    for (const kicker of ['Daily progress', 'Evidence', 'Verification',
                          'Approvals', 'Issues', 'Management view', 'Audit trail']) {
      const hits = screen.getAllByText(kicker).filter(
        (el) => el.className.includes('lp-kicker'));
      expect(hits, `${kicker} section missing`).toHaveLength(1);
    }
  });

  it('uses the product\'s own vocabulary, not generic marketing copy', () => {
    mount(<Landing />);
    // The claims that distinguish this product. If a rewrite loses these, the
    // page has drifted from what the application does.
    expect(screen.getByText(/cannot be signed off by whoever fixed it/i)).toBeInTheDocument();
    expect(screen.getByText(/never erases what site originally said/i)).toBeInTheDocument();
    expect(screen.getByText(/a retry after a timeout cannot become a second entry/i))
      .toBeInTheDocument();
    // And no invented social proof.
    expect(screen.queryByText(/trusted by|customers|testimonial/i)).toBeNull();
  });

  it('the construction scene has six stages and an accessible description', () => {
    expect(STAGES).toHaveLength(6);
    expect(STAGES[0]!.at).toBe(0);
    expect(STAGES[5]!.label).toBe('Complete');
    render(<BuildingScene progress={0.5} />);
    // Screen readers get the progress as text; the SVG is not decorative.
    expect(screen.getByRole('img', { name: /50 percent/i })).toBeInTheDocument();
  });

  it('the scene renders at every stage without throwing', () => {
    // A scroll position between two stages must still produce a coherent
    // building — that is the whole point of interpolating rather than
    // switching between six fixed frames.
    for (const p of [0, 0.13, 0.29, 0.47, 0.66, 0.83, 1]) {
      const { unmount } = render(<BuildingScene progress={p} />);
      expect(screen.getByRole('img')).toBeInTheDocument();
      unmount();
    }
  });

  it('offers both front doors — office and site', () => {
    mount(<Landing />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/login');
    expect(hrefs).toContain('/site/login');
  });
});
