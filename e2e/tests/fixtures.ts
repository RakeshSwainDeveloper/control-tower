import { test, expect } from '@playwright/test';

/**
 * No request rewriting.
 *
 * The dev app used an absolute `http://localhost:3000/api/v1`, so the browser
 * inside the e2e container tried to reach its own loopback and every call
 * failed. Two Playwright rewrites were attempted before the real fix: the API
 * base is now relative and Vite proxies `/api` onward, so a laptop browser, a
 * container browser and a phone on the LAN all reach the same API the same way.
 *
 * Kept as a module so the specs have one import to change if the harness ever
 * does need fixtures again.
 */
export { test, expect };
