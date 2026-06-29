import { e2eUsers } from '../src/config';
import { expectUserMenuIdentity, loginViaUI, logoutViaUI } from '../src/auth';
import { expect, test } from '../src/fixtures';

test.describe('auth state propagation', () => {
  test('same-tab account switch updates the header identity', async ({ page }) => {
    await loginViaUI(page, e2eUsers.userA);

    // Do not log out: overwrite the existing token pair by submitting the login
    // form as a different user in the same tab. The assertion deliberately reads
    // the header dropdown (useAuth/auth cache), not the URL or page body.
    await loginViaUI(page, e2eUsers.userB);
    await expectUserMenuIdentity(page, e2eUsers.userB);
  });

  test('cross-tab logout redirects the existing tab to login', async ({ browser }) => {
    const context = await browser.newContext();
    const tabA = await context.newPage();
    await loginViaUI(tabA, e2eUsers.userA);
    await tabA.goto(`/user/${e2eUsers.userA.username}`);

    const tabB = await context.newPage();
    await tabB.goto(`/user/${e2eUsers.userA.username}`);
    await expectUserMenuIdentity(tabB, e2eUsers.userA);

    await logoutViaUI(tabB, e2eUsers.userA);
    await expect(tabA).toHaveURL(/\/login(?:\?.*)?$/, { timeout: 30_000 });
    await context.close();
  });

  test('cross-tab account switch updates the existing tab header identity', async ({ browser }) => {
    const context = await browser.newContext();
    const tabA = await context.newPage();
    await loginViaUI(tabA, e2eUsers.userA);
    await tabA.goto(`/user/${e2eUsers.userA.username}`);

    const tabB = await context.newPage();
    await tabB.goto(`/user/${e2eUsers.userA.username}`);
    await expectUserMenuIdentity(tabB, e2eUsers.userA);

    await loginViaUI(tabB, e2eUsers.userB);
    await expectUserMenuIdentity(tabA, e2eUsers.userB);
    await context.close();
  });

  test('authenticated reload does not bounce to login', async ({ userAPage }) => {
    await userAPage.goto(`/user/${e2eUsers.userA.username}`);
    await expectUserMenuIdentity(userAPage, e2eUsers.userA);

    await userAPage.reload();
    await expect(userAPage).not.toHaveURL(/\/login(?:\?.*)?$/);
    await expectUserMenuIdentity(userAPage, e2eUsers.userA);
  });

  test('explicit logout clears state before logging in as another user', async ({ page }) => {
    await loginViaUI(page, e2eUsers.userA);
    await logoutViaUI(page, e2eUsers.userA);
    await loginViaUI(page, e2eUsers.userB);

    await expectUserMenuIdentity(page, e2eUsers.userB);
  });
});
