import { defineConfig, devices } from '@playwright/test';
import { E2E_API_URL, E2E_WEB_PROD, E2E_WEB_URL } from './src/config';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  // DB reset/preflight intentionally runs in package.json before `playwright test`.
  // Playwright starts webServer entries before config-level globalSetup, which
  // is too late for Crowi's boot-time config cache and first-run installer state.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: E2E_WEB_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: [
    {
      command: 'pnpm --filter @crowi/e2e start:api',
      url: `${E2E_API_URL}/api/app/info`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: E2E_WEB_PROD ? 'pnpm --filter @crowi/e2e start:web:prod' : 'pnpm --filter @crowi/e2e start:web',
      url: E2E_WEB_URL,
      timeout: E2E_WEB_PROD ? 600_000 : 120_000,
      // A reused server on this port may be the dev one, where prefetching never runs.
      reuseExistingServer: !process.env.CI && !E2E_WEB_PROD,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e',
      dependencies: ['setup'],
      testMatch: /.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
