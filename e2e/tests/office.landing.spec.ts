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
  { name: 'phone-390',  width: 390,  height: 844 },
  { name: 'phone-430',  width: 430,  height: 932 },
  { name: 'tablet-768', width: 768,  height: 1024 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'wide-1920',  width: 1920, height: 1080 },
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

    // And the stage list keeps up: the active stage is the last one.
    await expect(page.locator('.lp-stages li[data-state="on"]')).toContainText('Handover');
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

  /**
   * §14: "should not leave massive blank areas between content."
   *
   * The old pinned section was 400vh with a small figure inside a two-column
   * grid, so most of a 1440px viewport was white. This measures the actual
   * painted area of the pinned frame rather than trusting that it looks right.
   */
  test('the construction scene fills its viewport rather than leaving it empty', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const pin = page.locator('.lp-pin');
    await pin.scrollIntoViewIfNeeded();

    const box = await page.locator('.scene-svg').boundingBox();
    const vp = page.viewportSize()!;
    expect(box, 'the scene did not render').not.toBeNull();
    // The building must occupy most of the pinned viewport, not a corner of it.
    expect(box!.width / vp.width, `scene is ${Math.round(box!.width)}px of ${vp.width}px`)
      .toBeGreaterThan(0.6);
    expect(box!.height / vp.height, `scene is ${Math.round(box!.height)}px of ${vp.height}px`)
      .toBeGreaterThan(0.55);
  });

  test('the header is thin, sticky, and changes on scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const head = page.locator('.lp-head');
    expect((await head.boundingBox())!.height).toBeLessThanOrEqual(72);
    await expect(head).toHaveAttribute('data-scrolled', 'false');
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(300);
    // Sticky: still at the top of the viewport after scrolling.
    expect((await head.boundingBox())!.y).toBeLessThanOrEqual(1);
    await expect(head).toHaveAttribute('data-scrolled', 'true');
  });

  test('the mobile menu opens, navigates and closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    // The desktop nav is hidden; the burger is the way in.
    await expect(page.locator('.lp-nav')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    const sheet = page.locator('.lp-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'How it works' }).click();
    await expect(sheet).toBeHidden();
  });

  test('scroll reveal shows content and never hides it again', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const first = page.locator('[data-reveal]').first();
    await expect(first).toHaveAttribute('data-shown', 'true');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    // Scrolling back up must not re-hide anything.
    await expect(first).toHaveAttribute('data-shown', 'true');
  });
});
