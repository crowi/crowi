import { e2eUsers, storageStatePath } from '../src/config';
import { expect, test } from '../src/fixtures';

/**
 * feature-app-shell-a11y (WEB-07) — `mobile-search.tsx` used to be a
 * hand-rolled `createPortal` overlay with no focus trap / focus restore /
 * `aria-modal`. It now rides the shared `Sheet` (Radix `Dialog`)
 * primitive, so the same interaction contract every other `Sheet` in the
 * app gets now applies here too. This spec exercises the mobile
 * (< 768px) trigger end to end on a narrow viewport: open → type → Enter
 * navigates to `/_search`, and both Esc and the back button close the
 * sheet and restore focus to the trigger.
 *
 * The corner ✕ close button `SheetContent` draws by default is
 * intentionally hidden in this rewrite (the back arrow already covers
 * that role), so this spec does not assert on it. The Tab-key focus trap
 * itself (cycling stays inside the sheet) is Radix's own guarantee and is
 * covered by manual QA per the feature spec's acceptance criteria, not
 * re-asserted here.
 */

const NARROW_VIEWPORT = { width: 375, height: 800 };
/** `search.global.placeholder` (en/ja) — the trigger's accessible name (also the input's). */
const SEARCH_LABEL = /^(Search pages|ページを検索)$/;
/** `common.go_back` (en/ja) — the sheet's back-arrow button. */
const GO_BACK_LABEL = /^(Go Back|戻る)$/;

test.describe('mobile search (narrow viewport)', () => {
  test.use({ viewport: NARROW_VIEWPORT });

  test('opening the trigger, typing, and pressing Enter navigates to /_search', async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath.userA, viewport: NARROW_VIEWPORT });
    const page = await context.newPage();
    await page.goto(`/user/${e2eUsers.userA.username}`);

    await page.getByRole('button', { name: SEARCH_LABEL }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The existing UX auto-focuses the search input on open (preserved via
    // `SheetContent`'s `onOpenAutoFocus`, not Radix's content-panel default).
    const input = page.locator('#mobile-search-input');
    await expect(input).toBeFocused();

    const token = `e2emobilesearch${Date.now()}`;
    await input.fill(token);
    await input.press('Enter');

    await expect(page).toHaveURL(new RegExp(`/_search\\?q=${token}`));
    await context.close();
  });

  test('Esc closes the sheet and restores focus to the trigger', async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath.userA, viewport: NARROW_VIEWPORT });
    const page = await context.newPage();
    await page.goto(`/user/${e2eUsers.userA.username}`);

    const trigger = page.getByRole('button', { name: SEARCH_LABEL });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(trigger).toBeFocused();

    await context.close();
  });

  test('the back button closes the sheet and restores focus to the trigger', async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath.userA, viewport: NARROW_VIEWPORT });
    const page = await context.newPage();
    await page.goto(`/user/${e2eUsers.userA.username}`);

    const trigger = page.getByRole('button', { name: SEARCH_LABEL });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: GO_BACK_LABEL }).click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();

    await context.close();
  });
});
