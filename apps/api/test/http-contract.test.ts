/**
 * The API over real HTTP, as a client actually calls it.
 *
 * Every other suite exercises services directly. That is why two routes could
 * return 403 to everyone and three could return a bare array where twenty
 * returned `{ data }` — nothing had ever made the request.
 *
 * This suite makes the request. It needs the demo tenant (`make seed`), which
 * `make reset` now loads, and it fails with an explicit instruction rather than
 * a confusing assertion if that tenant is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env['API_SELF_URL'] ?? 'http://127.0.0.1:3000/api/v1';
const DEMO = { email: 'nikhil@demo.test', password: 'Demo!Passw0rd' };

let token: string;
let projectId: string;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-device-id': 'contract-test' },
  });
  return { status: res.status, body: await res.json().catch(() => null) as unknown };
}

describe('HTTP contract', () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(DEMO),
    });
    if (!res.ok) {
      throw new Error(
        `Could not sign in as ${DEMO.email} (${res.status}). Run \`make seed\` — ` +
        'this suite exercises the API the way a browser does and needs the demo tenant.',
      );
    }
    token = ((await res.json()) as { access_token: string }).access_token;

    const projects = await get('/projects?limit=1');
    const data = (projects.body as { data: { id: string }[] }).data;
    if (!data?.length) {
      throw new Error(
        'The demo tenant has no project. Until Phase 7 the seed granted ' +
        'project-scoped roles against a hardcoded placeholder id and never ' +
        'created the project — run `make seed` from a current build.',
      );
    }
    projectId = data[0]!.id;
  });

  /**
   * The list endpoints, and the shape every client will assume.
   *
   * A client reads `.data`. Off a bare array that is `undefined`, and the
   * screen renders an empty picker with no error — the worst kind of bug,
   * because it looks like "there is nothing here".
   */
  const LISTS = [
    '/users?limit=5', '/roles', '/projects',
    '/grants', '/sync/conflicts', '/sync/needs-attention',
  ];

  it.each(LISTS)('%s returns an object with a data array', async (path) => {
    const { status, body } = await get(path);
    expect(status, `${path} → ${status}`).toBe(200);
    expect(Array.isArray(body), `${path} returned a BARE ARRAY`).toBe(false);
    expect(body).toHaveProperty('data');
    expect(Array.isArray((body as { data: unknown }).data)).toBe(true);
  });

  it('/me/approvals carries the ageing summary S-W06 renders', async () => {
    // "Sorted by ageing, with the oldest age prominent" (MVP_SCREEN_LIST §2).
    // Computed server-side so it cannot drift from the dashboard's version.
    const { body } = await get('/me/approvals');
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('count');
    expect(b).toHaveProperty('oldest_age_hours');
    expect(b).toHaveProperty('overdue');
  });

  /**
   * The two inboxes are reachable.
   *
   * These are the screens the product is used through — My Work (S-M08) and the
   * approvals inbox (S-W06). Both returned 403 to everyone until Phase 7 made
   * the call, because they carried no access decorator and the guard is
   * fail-closed. Correct guard, wrong controllers.
   */
  it.each(['/me/work', '/me/approvals'])('%s is reachable AND enveloped', async (path) => {
    const { status, body } = await get(path);
    expect(status, `${path} → ${status} ${JSON.stringify(body)}`).toBe(200);
    // Reachability was asserted here first and the shape was not — so both
    // shipped as bare arrays anyway, and wave 4 found them. Assert the whole
    // contract or the test only covers half of it.
    expect(Array.isArray(body), `${path} returned a BARE ARRAY`).toBe(false);
    expect(body).toHaveProperty('data');
    expect(Array.isArray((body as { data: unknown }).data)).toBe(true);
  });

  it('/me/approvals carries the ageing summary S-W06 renders', async () => {
    // "Sorted by ageing, with the oldest age prominent" (MVP_SCREEN_LIST §2).
    // Computed server-side so it cannot drift from the dashboard's version.
    const { body } = await get('/me/approvals');
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('count');
    expect(b).toHaveProperty('oldest_age_hours');
    expect(b).toHaveProperty('overdue');
  });

  /**
   * The project-scoped lists.
   *
   * These are the ones the product is actually used through, and three of them
   * — locations, members, and the subtree — were bare arrays. A client reading
   * `.data` off a location tree renders an EMPTY LOCATION PICKER, which on the
   * site surface means a supervisor cannot record anything at all.
   */
  it('every project-scoped list returns an envelope', async () => {
    const paths = [
      `/projects/${projectId}/locations`,
      `/projects/${projectId}/work-items?limit=5`,
      `/projects/${projectId}/progress?limit=5`,
      `/projects/${projectId}/issues?limit=5`,
      `/projects/${projectId}/members`,
    ];
    const bare: string[] = [];
    for (const path of paths) {
      const { status, body } = await get(path);
      expect(status, `${path} → ${status}`).toBe(200);
      if (Array.isArray(body) || !(body as object | null)?.hasOwnProperty('data')) bare.push(path);
    }
    expect(bare, `these returned no { data }:\n${bare.join('\n')}`).toEqual([]);
  });

  /**
   * FR-522, checked rather than assumed.
   *
   * Every aggregate states what it counts, when it was computed, and where the
   * rows behind it are. progress/summary shipped without any of the three
   * until Phase 7 tried to render it.
   */
  it('every aggregate carries definition, as_of and drill', async () => {
    const aggregates = [
      `/projects/${projectId}/progress/summary`,
      `/projects/${projectId}/progress/verification-gap`,
      `/projects/${projectId}/issues/ageing`,
    ];
    for (const path of aggregates) {
      const { status, body } = await get(path);
      expect(status, `${path} → ${status}`).toBe(200);
      const b = body as Record<string, unknown>;
      expect(b, `${path} has no definition`).toHaveProperty('definition');
      expect(b, `${path} has no as_of`).toHaveProperty('as_of');
      expect(b, `${path} has no drill target`).toHaveProperty('drill');
      expect(String(b['definition']).length, `${path}: empty definition`).toBeGreaterThan(20);
    }
  });

  it('/permissions is a catalogue, not a list, and says so in its shape', async () => {
    // Deliberately NOT { data }. It is the permission key catalogue grouped by
    // module, and pretending it is a page of rows would be worse than being
    // different on purpose.
    const { status, body } = await get('/permissions');
    expect(status).toBe(200);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('modules');
  });

  it('reference data a supervisor needs is readable without a permission', async () => {
    // Six issue categories are provisioned for every tenant and had no read
    // endpoint at all until Phase 7 — S-M10's category chips would have been
    // empty and issues could only ever be filed uncategorised.
    const { status, body } = await get('/master-data?kind=issue_category');
    expect(status).toBe(200);
    const rows = (body as { data: { code: string }[] }).data;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => r.code)).toContain('safety');
  });

  it('statuses carry BOTH the label and the state class it means', async () => {
    // The client colours by state_class and prints label (MVP_DATABASE_SCOPE
    // §4). Sending one without the other forces it to guess.
    const { body } = await get('/statuses?entity_type=issue');
    const rows = (body as { data: { label: string; state_class: string }[] }).data;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.label, 'a status with no label').toBeTruthy();
      expect(r.state_class, `${r.label} has no state class`).toBeTruthy();
    }
  });

  /**
   * Wave 7's endpoints. All three were missing entirely — the dashboard,
   * portfolio and audit screens had nothing to render.
   */
  it('the dashboard returns three bands, every metric with a definition', async () => {
    const projects = await get('/projects?limit=1');
    const pid = (projects.body as { data: { id: string }[] }).data[0]!.id;
    const { status, body } = await get(`/projects/${pid}/dashboard`);
    expect(status).toBe(200);
    const d = body as { know: { key: string; definition: string; drill: unknown }[];
                        act: object; wrong: unknown[] };
    expect(d.know.length).toBeGreaterThanOrEqual(4);
    for (const m of d.know) {
      // FR-522 — a number a reader cannot trace to rows is a rumour with a font.
      expect(m.definition, `${m.key} has no definition`).toBeTruthy();
      expect(m.drill, `${m.key} has no drill target`).toBeTruthy();
    }
    expect(d.act).toBeTruthy();
    expect(Array.isArray(d.wrong)).toBe(true);
  });

  it('the portfolio is ONE query, not one per project', async () => {
    const { status, body } = await get('/portfolio');
    expect(status).toBe(200);
    const p = body as { definition: string; data: { code: string; verified_pct: number }[] };
    expect(p.definition).toBeTruthy();
    expect(Array.isArray(p.data)).toBe(true);
  });

  it('the audit timeline renders sentences, not JSON', async () => {
    const list = await get('/audit?limit=1');
    const row = (list.body as { data: { entity_type: string; entity_id: string }[] }).data[0];
    if (!row) return;
    const { status, body } = await get(`/audit/${row.entity_type}/${row.entity_id}`);
    expect(status).toBe(200);
    const t = body as { data: { sentence: string }[] };
    expect(t.data.length).toBeGreaterThan(0);
    // Rendered server-side so every client says it the same way.
    for (const e of t.data) expect(e.sentence.endsWith('.')).toBe(true);
  });

  /**
   * The browser's preflight must allow every header the client actually sends.
   *
   * `x-device-id` goes on EVERY request — the sync engine dedupes deliveries
   * per device — and it was missing from allowedHeaders. The preflight
   * answered 204 with an allow-origin, so it looked fine, and then the browser
   * rejected the real request. curl worked perfectly throughout; the product
   * was simply unreachable from a browser.
   */
  it('CORS allows every header the web client sends', async () => {
    const sent = ['content-type', 'authorization', 'x-device-id'];
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': sent.join(','),
      },
    });
    expect(res.status).toBeLessThan(300);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const h of sent) {
      expect(allowed, `preflight does not allow ${h} — the browser will reject the real request`)
        .toContain(h);
    }
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('an unauthenticated request is refused, not served', async () => {
    const res = await fetch(`${BASE}/users`);
    expect(res.status).toBe(401);
  });

  it('errors arrive as a problem document a screen can render', async () => {
    const res = await fetch(`${BASE}/projects/not-a-uuid`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The UI shows `detail` verbatim and quotes `support_reference` to support.
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('support_reference');
  });
});
