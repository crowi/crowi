import { createPageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * A client-side navigation moves focus to the `<main>` landmark, and the first
 * key press after it (PageDown while reading) makes the browser draw that
 * focus as `:focus-visible`. The frame must trace the region the page actually
 * occupies: the page view widens out of the centred column, and between
 * 1280px and 1440px the TOC rail pulls the article left of centre, so a frame
 * drawn on the centred column alone cuts across the article.
 */
test('the focused main landmark encloses the page column it frames', async ({ userAPage }) => {
  await userAPage.setViewportSize({ width: 1366, height: 900 });
  const base = `/e2e/main-focus-ring/${Date.now()}`;
  const target = `${base}/target`;
  await createPageViaApi(userAPage.context(), { path: target, body: '# Target\n\n## One\n\ntext\n\n## Two\n\ntext\n' });
  await createPageViaApi(userAPage.context(), { path: base, body: `# Start\n\n[go to target](${target})\n` });

  await userAPage.goto(base);
  await userAPage.getByRole('link', { name: 'go to target' }).click();
  await expect(userAPage).toHaveURL(new RegExp(`${target}$`));
  await expect.poll(() => userAPage.evaluate(() => document.activeElement?.id)).toBe('main-content');

  await expect(userAPage.locator('[data-toc-columns]')).toBeVisible();
  await userAPage.keyboard.press('PageDown');
  const geometry = await userAPage.evaluate(() => {
    const main = document.getElementById('main-content') as HTMLElement;
    const column = document.querySelector('[data-toc-columns] > :nth-child(2)') as HTMLElement;
    const m = main.getBoundingClientRect();
    const c = column.getBoundingClientRect();
    return { focusVisible: main.matches(':focus-visible'), mainLeft: m.left, mainRight: m.right, columnLeft: c.left, columnRight: c.right };
  });

  expect(geometry.focusVisible).toBe(true);
  expect(geometry.mainLeft).toBeLessThanOrEqual(geometry.columnLeft);
  expect(geometry.mainRight).toBeGreaterThanOrEqual(geometry.columnRight);
});
