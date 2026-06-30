import { expect, type Page } from '@playwright/test';
import type { E2eUserCredentials } from '../config';

export class InviteAcceptPage {
  constructor(private readonly page: Page) {}

  async acceptInvite(inviteLink: string, credentials: E2eUserCredentials): Promise<void> {
    await this.page.goto(inviteLink);
    await expect(this.page.locator('body')).toContainText(credentials.email);
    await this.page.locator('#username').fill(credentials.username);
    await this.page.locator('#name').fill(credentials.name);
    await this.page.locator('#password').fill(credentials.password);

    await Promise.all([
      this.page.waitForURL(new RegExp(`/user/${credentials.username}$`), { timeout: 30_000 }),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    await expect(this.page.getByRole('button', { name: new RegExp(credentials.name) })).toBeVisible();
  }
}
