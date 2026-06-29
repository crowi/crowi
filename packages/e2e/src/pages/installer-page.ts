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

    await Promise.all([
      this.page.waitForResponse((response) => response.url().endsWith('/api/v2/auth/login') && response.request().method() === 'POST' && response.ok()),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    await expect(this.page.getByRole('button', { name: new RegExp(credentials.name) })).toBeVisible({ timeout: 30_000 });
    await expect(this.page).not.toHaveURL(/\/installer$/);
  }
}
