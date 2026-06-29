import { test as base, expect, type Page } from '@playwright/test';
import { storageStatePath } from './config';

interface CrowiFixtures {
  /** A page in a context restored from the user-a storageState (authenticated as user-a). */
  userAPage: Page;
  /** A page in a context restored from the user-b storageState (authenticated as user-b). */
  userBPage: Page;
}

/**
 * Shared Playwright fixtures for the multi-state scenarios. `userAPage` /
 * `userBPage` give each test an independently-authenticated browser context
 * (separate cookie jar + localStorage), reused from the storageState the
 * `setup` project saved. Tests that need a fresh, unauthenticated context (the
 * same-tab / cross-tab UI flows) use the default `page` / `context` fixtures
 * instead — the e2e project sets no project-level storageState.
 */
export const test = base.extend<CrowiFixtures>({
  userAPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStatePath.userA });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
  userBPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStatePath.userB });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
