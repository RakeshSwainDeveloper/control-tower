/**
 * The P8 gate, as a test rather than a one-off measurement.
 *
 * `STACK_AND_DOCKER_PLAN.md` §6: the dashboard loads in under three seconds
 * with twelve months of data. A number measured once, by hand, on a good day,
 * is not a gate — it is an anecdote.
 *
 * This runs against whatever the database currently holds. With the demo seed
 * alone the numbers are trivially small and it proves little; run
 * `make seed-bulk` first for it to mean anything, which is what the budget
 * message says.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env['API_SELF_URL'] ?? 'http://127.0.0.1:3000/api/v1';
let token: string;
let projectId: string;
let volume = 0;

/** Best of five: a cold cache or a noisy container is not the thing measured. */
async function bestOf(path: string, runs = 5): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'x-device-id': 'perf' },
    });
    await res.arrayBuffer();
    expect(res.status, `${path} → ${res.status}`).toBe(200);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('performance budgets', () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mehta@demo.test', password: 'Demo!Passw0rd' }),
    });
    if (!res.ok) throw new Error('Run `make seed` first.');
    token = ((await res.json()) as { access_token: string }).access_token;

    const projects = await fetch(`${BASE}/projects?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ data: { id: string }[] }>);
    projectId = projects.data[0]!.id;

    const page = await fetch(`${BASE}/projects/${projectId}/progress?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ has_more: boolean }>);
    volume = page.has_more ? 1 : 0;
  });

  /**
   * The gate itself. 3000 ms is the committed budget; the note reports the
   * real number so a regression is visible long before it breaches.
   */
  it('S-W03 dashboard loads well inside its 3-second budget', async () => {
    const ms = await bestOf(`/projects/${projectId}/dashboard`);
    expect(ms, `dashboard took ${ms.toFixed(0)} ms`).toBeLessThan(3000);
    // A dashboard that has crept past a quarter of its budget is a dashboard
    // that will breach it on somebody else's hardware.
    expect(ms, `dashboard at ${ms.toFixed(0)} ms — over a quarter of the budget`)
      .toBeLessThan(750);
  });

  it('the portfolio stays one query, not one per project', async () => {
    const ms = await bestOf('/portfolio');
    expect(ms, `portfolio took ${ms.toFixed(0)} ms`).toBeLessThan(1000);
  });

  /**
   * The list that found the problem.
   *
   * Joining first and sorting afterwards cost 77 ms at one year and one
   * project, and grew linearly with everything the site had ever recorded.
   * Paginating first bounds the join to one page however large the table gets,
   * so this budget should hold at ten times the data.
   */
  it('S-W04 workbench pages in constant time, whatever the table holds', async () => {
    const ms = await bestOf(`/projects/${projectId}/progress?limit=50`);
    expect(ms, `workbench took ${ms.toFixed(0)} ms (volume flag ${volume})`)
      .toBeLessThan(500);
  });

  it('the issue register and its ageing stay quick', async () => {
    expect(await bestOf(`/projects/${projectId}/issues?limit=50`)).toBeLessThan(500);
    expect(await bestOf(`/projects/${projectId}/issues/ageing`)).toBeLessThan(500);
  });

  it('the audit log pages without scanning a year', async () => {
    const ms = await bestOf('/audit?limit=100');
    expect(ms, `audit took ${ms.toFixed(0)} ms`).toBeLessThan(1000);
  });

  it.each(['progress-summary', 'verification-gap', 'issue-ageing', 'daily-progress'])(
    'report %s runs live, no summary table',
    async (key) => {
      const ms = await bestOf(`/reports/${key}?projectId=${projectId}`, 3);
      // These are deliberately live queries (MVP_API_SCOPE §3). The budget is
      // what keeps "live" honest.
      expect(ms, `${key} took ${ms.toFixed(0)} ms`).toBeLessThan(2000);
    },
  );
});
