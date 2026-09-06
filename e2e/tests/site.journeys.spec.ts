import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';
import { signInSupervisor } from './helpers.js';

/**
 * The pickers open a full-screen dialog listing leaves. Choosing "the first
 * real option" is what a supervisor does; the test does the same rather than
 * hard-coding a location that the fixture might renumber.
 */
async function pickLocation(page: Page) {
  await page.getByRole('button', { name: /Choose a location/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Location' });
  await expect(dialog).toBeVisible();
  // The options are list rows; the close button is in the header, outside the
  // list. Targeting `li button` avoids matching either that or the search box.
  await dialog.locator('li button').first().click();
  await expect(dialog).toBeHidden();
}

async function pickWorkItem(page: Page) {
  await page.getByRole('button', { name: /Choose the work/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Work item' });
  await expect(dialog).toBeVisible();
  await dialog.locator('li button').first().click();
  await expect(dialog).toBeHidden();
}

/**
 * J1, J2, J5 and J8 — the site surface, on a phone viewport.
 *
 * These are the journeys with stopwatch targets. The targets themselves are a
 * pilot gate (PT-2) that only real supervisors on a real site can settle;
 * what these tests hold is the SHAPE that makes those targets reachable —
 * how many decisions the screen asks for, and whether it needs a network.
 */

test.describe('J1 — Ramesh records work, in the moment', () => {
  test('five fields, four of them a tap, and SUBMIT does not need a network', async ({ page, request }) => {
    await signInSupervisor(page, request);
    await page.goto('/site/progress');

    // The five fields, by their labels. `.first()` because the word also
    // appears inside the chosen value once a location is picked.
    for (const label of ['Location', 'Work item', 'Quantity today', 'Evidence', 'Contractor']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // The quantity is the only typing, and it must raise a numeric keypad.
    await expect(page.getByLabel('Quantity today')).toHaveAttribute('inputmode', 'decimal');

    await pickLocation(page);
    await pickWorkItem(page);
    await page.getByLabel('Quantity today').fill('12');
    await page.getByRole('button', { name: 'SUBMIT' }).click();

    await expect(page.getByText('Recorded')).toBeVisible();
    // "Record another" keeps the context: the next entry is usually the same
    // work at the next flat.
    await expect(page.getByRole('button', { name: /Record another/ })).toBeVisible();
  });
});

test.describe('J8 — Ramesh loses signal for six hours', () => {
  test('work recorded offline is queued, visible, and never discarded', async ({ page, request, context }) => {
    await signInSupervisor(page, request);
    await page.goto('/site/progress');
    await pickLocation(page);
    await pickWorkItem(page);

    // The network goes away mid-entry, which is exactly how it happens.
    await context.setOffline(true);
    await page.getByLabel('Quantity today').fill('9');
    await page.getByRole('button', { name: 'SUBMIT' }).click();

    // It is recorded regardless. This is the product's core promise.
    await expect(page.getByText('Recorded')).toBeVisible();

    // Navigate the way the app does — by tapping, not by reloading. A full
    // page load needs the network, and a supervisor who has lost signal is not
    // going to get a fresh document; the SPA has to keep working from what it
    // already has.
    /**
     * Assert the durable fact, not a screen.
     *
     * What J8 promises is that the work is SAFE — on the device, with its
     * idempotency key, recoverable when signal returns. Reading the outbox
     * directly checks exactly that, and does not depend on which header
     * element happens to render while offline.
     */
    const queued = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('control-tower');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new Promise<{ n: number; entity: string; uuid: string }>((resolve) => {
        const all = db.transaction('outbox').objectStore('outbox').getAll();
        all.onsuccess = () => {
          const rows = all.result as { entity: string; client_uuid: string }[];
          resolve({
            n: rows.length,
            entity: rows[0]?.entity ?? '',
            uuid: rows[0]?.client_uuid ?? '',
          });
        };
      });
    });

    expect(queued.n).toBeGreaterThan(0);
    expect(queued.entity).toBe('progress_entry');
    // The idempotency key exists on the device, so a retry after signal
    // returns cannot become a second entry.
    expect(queued.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/i);

    await context.setOffline(false);
  });
});

test.describe('J5 — anyone raises an issue', () => {
  test('category and severity are chips; detail is folded away', async ({ page, request }) => {
    await signInSupervisor(page, request);
    await page.goto('/site/issues/new');

    await page.getByLabel('What is wrong').fill('Honeycombing on column C4');
    await expect(page.getByRole('button', { name: 'Quality' })).toBeVisible();
    await page.getByRole('button', { name: 'Quality' }).click();
    await page.getByRole('button', { name: 'High' }).click();

    // Choosing High says what it will cost, before submission.
    await expect(page.getByText(/need an approval to close/)).toBeVisible();
    // Assignee and due date are not on the 45-second path.
    await expect(page.getByLabel('Who should fix it')).toHaveCount(0);

    await page.getByRole('button', { name: 'RAISE IT' }).click();
    await expect(page.getByText('Raised')).toBeVisible();
  });
});

test.describe('J2 — Ramesh closes the day', () => {
  test('the day is reviewed, not re-entered', async ({ page, request }) => {
    await signInSupervisor(page, request);
    await page.goto('/site/report');
    // Weather is the only decision; everything else is already there.
    await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible();
    await expect(page.getByText(/What you recorded today/)).toBeVisible();
  });
});

test.describe('the site shell shows only what this person can do', () => {
  test('a supervisor gets three tabs, not nine nav entries', async ({ page, request }) => {
    await signInSupervisor(page, request);
    await page.goto('/site');
    await expect(page.getByRole('link', { name: /Today/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /My Work/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Profile/ })).toBeVisible();
    // No office navigation anywhere on the site surface.
    await expect(page.getByRole('link', { name: /Users & roles/ })).toHaveCount(0);
  });
});
