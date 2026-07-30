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

  test('transient server error keeps the session instead of bouncing to login', async ({ userAPage }) => {
    await userAPage.goto(`/user/${e2eUsers.userA.username}`);
    await expectUserMenuIdentity(userAPage, e2eUsers.userA);

    // Emulate the API server being temporarily down for the auth check. This is
    // network-layer fault injection (Playwright route interception) — the app
    // is unmodified; only the `/auth/me` response is replaced with a 503.
    await userAPage.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'emulated outage' } }),
      });
    });

    await userAPage.reload();

    // A 5xx must NOT log an authenticated user out: the app surfaces the
    // server-error modal and stays put rather than redirecting to /login
    // (the `fetchMe` 5xx branch keeps the tokens).
    await expect(userAPage.getByRole('dialog')).toContainText('サーバーエラー');
    await expect(userAPage).not.toHaveURL(/\/login(?:\?.*)?$/);

    // Recovery: once the server is healthy again, the connection context's
    // automatic retry (5s countdown — `RETRY_INTERVALS[0]` in
    // connection-context.tsx) re-fetches `/auth/me` and restores the
    // authenticated identity WITHOUT a re-login — proving the session was
    // never cleared during the outage. Do not drive this via the "reconnect
    // now" button: a manual click races the same auto-retry timer (both
    // call the same registered retry callback), and can catch the button
    // mid-unmount just as the auto-retry closes the error dialog, detaching
    // the element under Playwright's click. The manual-retry wiring itself
    // is covered by a unit test instead (auth-sync.test.tsx: "refetches the
    // auth query via the single registered retry callback").
    await userAPage.unroute('**/api/auth/me');
    await expect(userAPage.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 });
    await expectUserMenuIdentity(userAPage, e2eUsers.userA);
  });
});
