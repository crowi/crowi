import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { E2eUserCredentials } from './config';

export async function loginViaUI(page: Page, credentials: E2eUserCredentials): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(credentials.email);
  await page.locator('#password').fill(credentials.password);

  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST' && response.ok()),
    page.locator('form button[type="submit"]').click(),
  ]);

  await expectUserMenuIdentity(page, credentials);
}

export function userMenuButton(page: Page, credentials: Pick<E2eUserCredentials, 'name' | 'username'>): Locator {
  return page.getByRole('button', { name: new RegExp(`${escapeRegExp(credentials.name)}|${escapeRegExp(credentials.username)}`) });
}

export async function openUserMenu(page: Page, credentials: Pick<E2eUserCredentials, 'name' | 'username'>): Promise<void> {
  await userMenuButton(page, credentials).click();
}

export async function expectUserMenuIdentity(page: Page, credentials: E2eUserCredentials): Promise<void> {
  await openUserMenu(page, credentials);
  const menu = page.getByRole('menu');
  await expect(menu).toContainText(`@${credentials.username}`);
  await expect(menu).toContainText(credentials.email);
  await page.keyboard.press('Escape');
}

export async function logoutViaUI(page: Page, credentials: E2eUserCredentials): Promise<void> {
  await openUserMenu(page, credentials);
  await Promise.all([page.waitForURL(/\/login(?:\?.*)?$/, { timeout: 30_000 }), page.getByRole('menuitem', { name: /Logout|ログアウト/ }).click()]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
