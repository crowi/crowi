import { expect, type Page } from '@playwright/test';
import type { E2eUserCredentials } from '../config';

export class InstallerPage {
  constructor(private readonly page: Page) {}

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(/\/installer$/);
    await expect(this.page.locator('#username')).toBeVisible();
    await expect(this.page.locator('#email')).toBeVisible();
  }

  async createAdmin(credentials: E2eUserCredentials): Promise<void> {
    await this.page.locator('#username').fill(credentials.username);
    await this.page.locator('#name').fill(credentials.name);
    await this.page.locator('#email').fill(credentials.email);
    await this.page.locator('#password').fill(credentials.password);

    // Counts full document loads of the admin destination: LocaleSync's
    // setLocale() reloads the page when the account's `lang` disagrees with
    // the locale cookie, which must not happen for a fresh install.
    let adminLoads = 0;
    this.page.on('load', () => {
      if (this.page.url().includes('/admin')) adminLoads += 1;
    });

    await Promise.all([
      this.page.waitForResponse((response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST' && response.ok()),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    await expect(this.page).toHaveURL(/\/admin\?welcome=installed$/, { timeout: 30_000 });

    // The post-install destination opens a one-shot welcome dialog on top of
    // the admin dashboard. It makes the background user menu inert, so drive
    // the dialog through its real flow before asserting the authenticated UI.
    const welcomeDialog = this.page.getByRole('dialog', { name: 'Setup complete 🎉' });
    await expect(welcomeDialog).toBeVisible({ timeout: 30_000 });
    // Give a pending locale reconciliation time to fire before judging.
    await this.page.waitForTimeout(2_000);
    expect(adminLoads).toBe(1);
    await expect(welcomeDialog).toBeVisible();
    await welcomeDialog.getByRole('button', { name: 'Get started' }).click();
    await expect(welcomeDialog).not.toBeVisible();
    await expect(this.page).toHaveURL(/\/admin$/);

    await expect(this.page.getByRole('button', { name: new RegExp(credentials.name) })).toBeVisible({ timeout: 30_000 });
  }
}
