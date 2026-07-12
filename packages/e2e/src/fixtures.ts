import { type Browser, test as base, expect, type Page } from '@playwright/test';
import { storageStatePath } from './config';

interface CrowiFixtures {
  /** A page in a context restored from the admin storageState (authenticated as the installer admin). */
  adminPage: Page;
  /** A page in a context restored from the user-a storageState (authenticated as user-a). */
  userAPage: Page;
  /** A page in a context restored from the user-b storageState (authenticated as user-b). */
  userBPage: Page;
}

/** Fixture factory shared by `adminPage` / `userAPage` / `userBPage`: a page in its own context restored from `storageState`. */
function authedPageFixture(storageState: string) {
  return async ({ browser }: { browser: Browser }, use: (page: Page) => Promise<void>) => {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await use(page);
    await context.close();
  };
}

/**
 * Shared Playwright fixtures for the multi-state scenarios. `adminPage` /
 * `userAPage` / `userBPage` give each test an independently-authenticated
 * browser context (separate cookie jar + localStorage), reused from the
 * storageState the `setup` project saved. Tests that need a fresh,
 * unauthenticated context (the same-tab / cross-tab UI flows) use the
 * default `page` / `context` fixtures instead — the e2e project sets no
 * project-level storageState.
 */
export const test = base.extend<CrowiFixtures>({
  adminPage: authedPageFixture(storageStatePath.admin),
  userAPage: authedPageFixture(storageStatePath.userA),
  userBPage: authedPageFixture(storageStatePath.userB),
});

export { expect };
