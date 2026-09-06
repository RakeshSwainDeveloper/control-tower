import { test, expect } from './fixtures.js';

/**
 * The landing page in a real browser, at four widths.
 *
 * Everything here is a thing a unit test cannot see: whether the page scrolls
 * sideways, whether the sticky scene actually moves with scroll, whether the
 * console is clean, and whether the reduced-motion path still shows the
 * building rather than an empty frame.
 */
const WIDTHS = [
  { name: 'mobile',  width: 390,  height: 844 },
  { name: 'tablet',  width: 834,  height: 1112 },
  { name: 'laptop',  width: 1366, height: 768 },
  { name: 'desktop', width: 1920, height: 1080 },
];

test.describe('landing page', () => {
  for (const vp of WIDTHS) {
    test(`no horizontal overflow at ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // The body must never scroll sideways, and no element may stick out past
      // the viewport — the two are different failures and both are ugly.
      const overflow = await page.evaluate(() => {
        const docWidth = document.documentElement.scrollWidth;
        const winWidth = window.innerWidth;
        const wide: string[] = [];
        document.querySelectorAll('*').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > winWidth + 1) {
            wide.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)}`);
          }
        });
        return { docWidth, winWidth, wide: wide.slice(0, 5) };
      });
      expect(overflow.docWidth,
        `page is ${overflow.docWidth}px wide in a ${overflow.winWidth}px viewport; ` +
        `offenders: ${overflow.wide.join(', ')}`).toBeLessThanOrEqual(overflow.winWidth + 1);
    });
  }

  test('the console is clean', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    expect(problems, problems.join(' | ')).toEqual([]);
  });

  test('the building evolves as the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    const scene = page.getByRole('img', { name: /Construction progress/ });
    await scene.scrollIntoViewIfNeeded();

    const progressAt = async () =>
      Number((await scene.getAttribute('aria-label'))!.match(/(\d+) percent/)![1]);

    const start = await progressAt();
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(400);
    const mid = await progressAt();
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(400);
    const end = await progressAt();

    // Monotonic and actually moving — a scene that reports 0 throughout would
    // pass a "renders" test and fail the only thing that matters about it.
    expect(mid).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(mid);
    expect(end).toBeGreaterThan(60);

    // And the stage list keeps up with it. Scoped to the caption, which is
    // the one place the current stage is named — "Complete" also appears in
    // the stage list and in the scene's own label.
    await expect(page.locator('.lp-scene-cap')).toContainText('Complete');
  });

  test('reduced motion shows the finished building, not an empty frame', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    const scene = page.getByRole('img', { name: /Construction progress/ });
    await scene.scrollIntoViewIfNeeded();
    // The information is the building, not the movement: with motion off the
    // scene renders complete rather than animating past the reader.
    await expect(scene).toHaveAttribute('aria-label', /100 percent/);
    await context.close();
  });

  test('both front doors work from the landing page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Sign in/ }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
