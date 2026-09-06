import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end over the nine journeys in MVP_USER_JOURNEYS.md.
 *
 * Runs against the real stack in Docker — the same API, the same database, the
 * same seeded tenant. A journey test against mocks would re-test the unit
 * tests and prove nothing about whether the product works.
 */
export default defineConfig({
  testDir: './tests',
  // Serial: these share one tenant and one project, and a journey that races
  // another journey's daily report produces a flake nobody can reproduce.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://web:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A site phone, not a desktop. J1–J5 and J8 are the site surface, and
    // testing them at 1280px would miss every layout problem that matters.
    ...devices['Pixel 5'],
  },
  projects: [
    { name: 'site', testMatch: /site\..*\.spec\.ts/, use: { ...devices['Pixel 5'] } },
    { name: 'office', testMatch: /office\..*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
});
