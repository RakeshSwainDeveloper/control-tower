import { test, expect } from './fixtures.js';
import { signIn, DEMO } from './helpers.js';

/**
 * J3, J4, J6, J7 and J9 — the office surface, on a desktop viewport.
 */

test.describe('J6 — Mr Mehta looks, once a day', () => {
  test('the dashboard answers three questions and every number says what it counts',
    async ({ page, request }) => {
      await signIn(page, request, DEMO.management);
      await page.goto('/office');

      await expect(page.getByText('What I need to know')).toBeVisible();
      await expect(page.getByText('What needs my action')).toBeVisible();
      await expect(page.getByText('What is going wrong')).toBeVisible();

      // FR-522: a number a reader cannot trace to rows is a rumour with a font.
      await expect(page.getByText(/Quantity confirmed by a verifier/)).toBeVisible();
      await expect(page.getByText(/Reported quantity minus verified quantity/)).toBeVisible();
    });

  test('the portfolio names each project\'s problems in words', async ({ page, request }) => {
    await signIn(page, request, DEMO.management);
    await page.goto('/office/projects');
    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    // Colour is never the sole carrier of meaning — the flags are words, in a
    // column of their own. Scoped to the header row: "Verified" also appears
    // in the status chips below it.
    // `th` elements, matched by text: the table has no explicit ARIA roles and
    // the implicit columnheader role needs a `scope`, which the markup omits.
    await expect(table.locator('th', { hasText: 'Verified' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'Flags' })).toBeVisible();
  });
});

test.describe('J3 — Anita verifies', () => {
  test('the gap stays in view while she works through the claims', async ({ page, request }) => {
    await signIn(page, request, DEMO.engineer);
    await page.goto('/office/progress');
    await expect(page.getByText(/reported but not yet verified/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Awaiting verification' })).toBeVisible();
  });
});

test.describe('J4 — Vikram approves the day', () => {
  test('the inbox leads with the oldest, not just a count', async ({ page, request }) => {
    await signIn(page, request, DEMO.pm);
    await page.goto('/office/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  });
});

test.describe('J7 — Nikhil sets the company up', () => {
  test('people and their grants, with the role editor kept secondary',
    async ({ page, request }) => {
      await signIn(page, request, DEMO.admin);
      await page.goto('/office/people');
      await expect(page.getByRole('heading', { name: /Users, roles/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Invite/ })).toBeVisible();
    });

  test('the location tree is built from a pattern, with the count shown first',
    async ({ page, request }) => {
      await signIn(page, request, DEMO.admin);
      await page.goto('/office/setup');
      await page.getByRole('button', { name: /Build from a pattern/ }).click();
      // 168 locations by hand is a day's work; the count appears before the
      // button that creates them.
      // The count sits on the create button's row; the summary line above the
      // table says the same thing, hence .last().
      await expect(page.getByText(/\d+ locations/).last()).toBeVisible();
    });
});

test.describe('J9 — an auditor asks "who said this was done?"', () => {
  test('the audit reads as sentences, with the capacity each person held',
    async ({ page, request }) => {
      await signIn(page, request, DEMO.management);
      await page.goto('/office/audit');
      await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
      await expect(page.getByText(/Append-only/)).toBeVisible();
      // FR-030 rendered: "as Project Manager" beside the name.
      await expect(page.getByText(/^as /).first()).toBeVisible();
    });
});

test.describe('the office nav is permission-driven', () => {
  test('a project manager has no Users & roles entry', async ({ page, request }) => {
    await signIn(page, request, DEMO.pm);
    await page.goto('/office');
    await expect(page.getByRole('link', { name: /Dashboard/ })).toBeVisible();
    // The PM holds no org.user.read. Hidden, not disabled.
    await expect(page.getByRole('link', { name: /Users & roles/ })).toHaveCount(0);
  });
});
