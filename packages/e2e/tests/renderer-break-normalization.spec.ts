import type { Locator } from '@playwright/test';
import { createPageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-renderer-break-normalization AC-9 — the one thing only a real
 * browser can prove: a normalized bare `<br>` (now a canonical mdast
 * `break`) actually creates a second visual line, in the two places the
 * spec's D-3 web-display-unchanged claim covers — an ordinary GFM table
 * cell and an author-built `white-space:pre` span (already excluded from
 * normalization, so it stays `html`, but the SAME real `<br>` element is
 * what makes it a real second line there too).
 *
 * Both measurements compare against a single-line REFERENCE element on
 * the SAME page (same table / same paragraph) rather than a hardcoded
 * pixel value, and use a two-sided bound: `reference < h < 2.5 ×
 * reference`. The lower bound alone would only prove "the line break
 * survived"; the upper bound is what catches the opposite regression —
 * an extra, unwanted line (D-3's residual RAWTEXT/RCDATA cases) — in
 * either direction.
 */

/** `Range` content height — excludes `td` border-box padding (which would let a false-3-line regression sneak under the 2.5× bound) and is unaffected by `white-space:pre`'s extra rects (`getClientRects().length` is NOT used — see the spec's own measurement note). */
async function contentHeight(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().height;
  });
}

test('a normalized bare <br> renders as a real second line in a table cell and in a white-space:pre span, bounded relative to a single-line reference', async ({
  userAPage,
}) => {
  const token = `e2ebreaknorm${Date.now()}`;
  const pagePath = `/e2e/renderer-break-normalization/${token}`;

  const body = [
    `# Break normalization ${token}`,
    '',
    '| ref | multi |',
    '| --- | --- |',
    `| ${token}-ref-cell | ${token}-multi-a<br>${token}-multi-b |`,
    '',
    `Paragraph with <span style="white-space:pre">${token}-ref-span</span> and <span style="white-space:pre">${token}-multi-a<br>${token}-multi-b</span> text.`,
    '',
  ].join('\n');

  await createPageViaApi(userAPage.context(), { path: pagePath, body });
  await userAPage.goto(pagePath);

  await test.step('table cell: the bare <br> cell is between 1x and 2.5x the height of the single-line reference cell in the same table', async () => {
    const refCell = userAPage.locator('table td').nth(0);
    const multiCell = userAPage.locator('table td').nth(1);
    await expect(refCell).toBeVisible();
    await expect(multiCell).toBeVisible();
    await expect(refCell).toContainText(`${token}-ref-cell`);
    await expect(multiCell).toContainText(`${token}-multi-a`);

    const referenceHeight = await contentHeight(refCell);
    const multiHeight = await contentHeight(multiCell);
    expect(referenceHeight).toBeGreaterThan(0);
    expect(multiHeight).toBeGreaterThan(referenceHeight);
    expect(multiHeight).toBeLessThan(referenceHeight * 2.5);
  });

  await test.step('white-space:pre span: the bare <br> span is between 1x and 2.5x the height of the single-line reference span in the same paragraph', async () => {
    const refSpan = userAPage.locator('span[style*="white-space"]').nth(0);
    const multiSpan = userAPage.locator('span[style*="white-space"]').nth(1);
    await expect(refSpan).toBeVisible();
    await expect(multiSpan).toBeVisible();
    await expect(refSpan).toContainText(`${token}-ref-span`);
    await expect(multiSpan).toContainText(`${token}-multi-a`);

    const referenceHeight = await contentHeight(refSpan);
    const multiHeight = await contentHeight(multiSpan);
    expect(referenceHeight).toBeGreaterThan(0);
    expect(multiHeight).toBeGreaterThan(referenceHeight);
    expect(multiHeight).toBeLessThan(referenceHeight * 2.5);
  });
});
