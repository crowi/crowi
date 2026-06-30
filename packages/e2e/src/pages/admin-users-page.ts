import { expect, type Page } from '@playwright/test';

export class AdminUsersPage {
  constructor(private readonly page: Page) {}

  async inviteUsersByEmail(emails: string[]): Promise<void> {
    await this.page.goto('/admin/users');
    await expect(this.page.locator('main')).toContainText(/Users|ユーザー/);

    await this.page.getByRole('button', { name: /Invite|招待/ }).click();
    await expect(this.page.locator('#invite-emails')).toBeVisible();
    await this.page.locator('#invite-emails').fill(emails.join('\n'));
    await this.page.locator('input[type="checkbox"]').check();

    await Promise.all([
      this.page.waitForResponse((response) => response.url().endsWith('/api/v2/admin/users/invite') && response.request().method() === 'POST' && response.ok()),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    for (const email of emails) {
      await expect(this.page.locator('body')).toContainText(email);
    }
  }
}
