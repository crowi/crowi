import { createPageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * On the top page, the sidebar's top link and the site logo point back at the
 * page already shown. A click there must refresh the page list in place, so a
 * page created since the visit shows up without a full browser reload.
 */
for (const [name, link] of [
  ['sidebar top link', 'nav[aria-label="Primary"] a[href="/"]'],
  ['site logo', 'header a[href="/"]'],
] as const) {
  test(`the ${name} refreshes the top page list in place`, async ({ userAPage }) => {
    await userAPage.setViewportSize({ width: 1440, height: 900 });
    await userAPage.goto('/');
    const marker = `top-reload-${name.replace(/\s/g, '-')}-${Date.now()}`;
    await expect(userAPage.locator('main a[href^="/"]').first()).toBeVisible();

    await createPageViaApi(userAPage.context(), { path: `/e2e/${marker}`, body: `# ${marker}\n` });
    await expect(userAPage.locator('main').getByText(marker)).toHaveCount(0);

    const navigations: string[] = [];
    userAPage.on('framenavigated', (frame) => frame === userAPage.mainFrame() && navigations.push(frame.url()));
    await userAPage.locator(link).first().click();

    await expect(userAPage.locator('main').getByText(marker).first()).toBeVisible();
    expect(navigations).toEqual([]);
  });
}
