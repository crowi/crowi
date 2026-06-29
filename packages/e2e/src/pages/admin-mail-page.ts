import { expect, type Page } from '@playwright/test';
import { e2eMail } from '../config';

export class AdminMailPage {
  constructor(private readonly page: Page) {}

  async configureSmtpMailpit(): Promise<void> {
    await this.page.goto(`/admin/plugins/edit?name=${encodeURIComponent('@crowi/plugin-mail-smtp')}`);
    await expect(this.page.locator('#field-host')).toBeVisible();

    await this.page.locator('#field-host').fill(e2eMail.smtpHost);
    await this.page.locator('#field-port').fill(String(e2eMail.smtpPort));
    await this.page.locator('#field-user').fill('');
    await this.page.locator('#field-password').fill('');

    const secure = this.page.locator('#field-secure');
    if ((await secure.getAttribute('aria-checked')) === 'true') {
      await secure.click();
    }

    await Promise.all([
      this.page.waitForResponse(
        (response) => response.url().includes('/api/v2/admin/plugins/config') && response.request().method() === 'PUT' && response.ok(),
      ),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    await expect(this.page.locator('form button[type="submit"]')).toBeDisabled();
  }

  async configureFromAddress(): Promise<void> {
    await this.page.goto('/admin/mail');
    await expect(this.page.locator('#mail-from')).toBeVisible();
    await this.page.locator('#mail-from').fill(e2eMail.from);

    await Promise.all([
      this.page.waitForResponse((response) => response.url().endsWith('/api/v2/admin/mail') && response.request().method() === 'PUT' && response.ok()),
      this.page.locator('form button[type="submit"]').click(),
    ]);

    await expect(this.page.locator('#mail-from')).toHaveValue(e2eMail.from);
    await expect(this.page.locator('form button[type="submit"]')).toBeDisabled();
  }
}
