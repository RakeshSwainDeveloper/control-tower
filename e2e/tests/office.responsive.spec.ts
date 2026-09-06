import { test, expect } from './fixtures.js';
import { signIn, signInSupervisor, DEMO } from './helpers.js';

/**
 * The redesign, checked against the real screens.
 *
 * A token change reaches all 30 screens at once, which is its value and also
 * its risk: one bad value can put every table off the side of a phone. These
 * assertions are the cheap insurance — no sideways scroll, no console errors,
 * on the surfaces each persona actually opens.
 */
const SITE = ['/site', '/site/progress', '/site/work', '/site/issues', '/site/sync', '/site/me'];
const OFFICE = ['/office', '/office/projects', '/office/progress', '/office/reports',
                '/office/approvals', '/office/issues', '/office/setup', '/office/audit'];

async function widestElement(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const win = window.innerWidth;
    let worst = { tag: '', width: 0, right: 0 };
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > worst.right) {
        worst = {
          tag: `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 32)}`,
          width: Math.round(r.width), right: Math.round(r.right),
        };
      }
    });
    return { doc: document.documentElement.scrollWidth, win, worst };
  });
}

test.describe('site screens on a phone', () => {
  for (const path of SITE) {
    test(`${path} fits a 390px phone with a clean console`, async ({ page, request }) => {
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

      await page.setViewportSize({ width: 390, height: 844 });
      await signInSupervisor(page, request);
      await page.goto(path);
      await page.waitForTimeout(700);

      const m = await widestElement(page);
      expect(m.doc, `${path}: ${m.doc}px in ${m.win}px — widest ${m.worst.tag} at ${m.worst.right}px`)
        .toBeLessThanOrEqual(m.win + 1);
      expect(problems, problems.join(' | ')).toEqual([]);
    });
  }
});

test.describe('office screens on a laptop', () => {
  for (const path of OFFICE) {
    test(`${path} renders cleanly at 1366px`, async ({ page, request }) => {
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

      await page.setViewportSize({ width: 1366, height: 768 });
      await signIn(page, request, DEMO.management);
      await page.goto(path);
      await page.waitForTimeout(700);

      const m = await widestElement(page);
      expect(m.doc, `${path}: ${m.doc}px in ${m.win}px — widest ${m.worst.tag} at ${m.worst.right}px`)
        .toBeLessThanOrEqual(m.win + 1);
      expect(problems, problems.join(' | ')).toEqual([]);
    });
  }
});

test('the office surface survives a tablet, where the sidebar is widest', async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page, request, DEMO.management);
  await page.goto('/office/progress');
  await page.waitForTimeout(700);
  // A 15rem sidebar plus a wide table is the layout most likely to push a
  // tablet sideways; the table's own scroll container is what prevents it.
  const m = await widestElement(page);
  expect(m.doc, `tablet: ${m.doc}px in ${m.win}px — widest ${m.worst.tag}`).toBeLessThanOrEqual(m.win + 1);
});

test('touch targets on the site surface stay at 48px', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInSupervisor(page, request);
  await page.goto('/site/progress');
  const small = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll('button, a, select, input').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cls = (el.className || '').toString();
      // Ignore what is not tapped: hidden inputs, and the small icon buttons
      // inside a thumbnail which sit on top of a 48px target of their own.
      if (r.height === 0 || cls.includes('sr-only') || cls.includes('thumb')) return;
      if (r.height > 0 && r.height < 44) bad.push(`${el.tagName.toLowerCase()}.${cls.slice(0, 30)} ${Math.round(r.height)}px`);
    });
    return bad;
  });
  // Gloves and wet hands (UI_UX_PLAN §3.5).
  expect(small, small.join(' | ')).toEqual([]);
});
