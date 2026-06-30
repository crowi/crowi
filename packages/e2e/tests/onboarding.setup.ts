import { expect, test } from '@playwright/test';
import { createPageViaApi } from '../src/api';
import { E2E_SHARED_PAGE_PATH, e2eUsers, storageStatePath } from '../src/config';
import { extractInviteLink, waitForLatestMessageTo } from '../src/mailpit';
import { AdminMailPage } from '../src/pages/admin-mail-page';
import { AdminUsersPage } from '../src/pages/admin-users-page';
import { InstallerPage } from '../src/pages/installer-page';
import { InviteAcceptPage } from '../src/pages/invite-accept-page';
import { writeSharedState } from '../src/shared-state';

test('onboarding: install admin, configure mailpit SMTP, invite users, and accept invites', async ({ page, browser }) => {
  await page.goto('/');
  const installer = new InstallerPage(page);
  await installer.expectVisible();

  await test.step('install via installer UI and auto-login as admin', async () => {
    await installer.createAdmin(e2eUsers.admin);
    await page.context().storageState({ path: storageStatePath.admin });
  });

  await test.step('configure SMTP sender and mail from via admin UI', async () => {
    const mail = new AdminMailPage(page);
    await mail.configureSmtpMailpit();
    await mail.configureFromAddress();
  });

  await test.step('invite user-a and user-b with sendEmail enabled', async () => {
    const users = new AdminUsersPage(page);
    await users.inviteUsersByEmail([e2eUsers.userA.email, e2eUsers.userB.email]);
  });

  const inviteLinks = await test.step('assert Mailpit delivery and extract invite links', async () => {
    const [messageA, messageB] = await Promise.all([waitForLatestMessageTo(e2eUsers.userA.email), waitForLatestMessageTo(e2eUsers.userB.email)]);
    const linkA = extractInviteLink(messageA);
    const linkB = extractInviteLink(messageB);
    expect(linkA).toContain('/invite/accept?token=');
    expect(linkB).toContain('/invite/accept?token=');
    return { userA: linkA, userB: linkB };
  });

  await test.step('accept invite as user-a via accept form', async () => {
    const context = await browser.newContext();
    const invitePage = await context.newPage();
    await new InviteAcceptPage(invitePage).acceptInvite(inviteLinks.userA, e2eUsers.userA);
    await context.storageState({ path: storageStatePath.userA });
    await context.close();
  });

  await test.step('accept invite as user-b via accept form', async () => {
    const context = await browser.newContext();
    const invitePage = await context.newPage();
    await new InviteAcceptPage(invitePage).acceptInvite(inviteLinks.userB, e2eUsers.userB);
    await context.storageState({ path: storageStatePath.userB });
    await context.close();
  });

  await test.step('create the shared collab page and record its id', async () => {
    const pageId = await createPageViaApi(page.context(), {
      path: E2E_SHARED_PAGE_PATH,
      body: '# E2E collab shared page\n\nSeeded by the onboarding setup project.\n',
    });
    await writeSharedState({ pageId, pagePath: E2E_SHARED_PAGE_PATH });
  });
});
