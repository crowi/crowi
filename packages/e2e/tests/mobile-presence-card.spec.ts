import { createPageViaApi } from '../src/api';
import { storageStatePath } from '../src/config';
import { expect, test } from '../src/fixtures';

/**
 * feature-mobile-presence-card — the mobile live-presence card, verified in
 * a real browser at real narrow viewports.
 *
 * The unit suite (`live-presence-row.test.tsx` / `page-header.test.tsx`)
 * covers the layout and lifecycle in jsdom, which has no layout engine, no
 * media-query evaluation and no scrolling — exactly the three things this
 * feature's acceptance criteria hinge on. This spec covers what only a
 * browser can answer:
 *
 *   1. at 320/375px the pre-title presence/TOC row is really absent (the
 *      AC says "not rendered", not "display: none"), and the card slot is
 *      the last thing in the expanded header — i.e. `title → author/updated
 *      → statistics chips → presence card` is the real order;
 *   2. 320px has no horizontal overflow;
 *   3. the self-only collapse enters and exits without moving the reader's
 *      position in the body — measured as the on-screen position of a
 *      paragraph the reader is looking at, which is the AC's own pass
 *      condition (and is independent of whether the engine's native scroll
 *      anchoring did the work or `preserve-scroll-anchor.ts` did).
 *
 * Playwright drives Chromium here, which DOES implement native scroll
 * anchoring; WebKit/iOS Safari (which does not) is the case that motivated
 * the JS compensation and still needs a device pass. Running this spec on
 * an anchoring engine is what pins the other half of that contract: the JS
 * correction must not double-compensate where the engine already acted.
 */

/** iPhone-SE-class width — the narrowest viewport the AC names. */
const VIEWPORT_320 = { width: 320, height: 800 };
/** The AC's second named width (iPhone 12/13/14-class). */
const VIEWPORT_375 = { width: 375, height: 800 };

/** `page.presence_card_aria` (en/ja) — the card / compact trigger name. */
const CARD_LABEL = /viewing now|閲覧中/;

/** New viewers are admitted after the 3s anti-flicker delay, so every
 * "the card appeared" wait needs headroom well past it. */
const PRESENCE_TIMEOUT_MS = 25_000;
/** CSS collapse transition (200ms) + the fallback settle timer + a margin,
 * after which the compensating scroll has certainly been applied. */
const SETTLE_MS = 800;

function bodyParagraphs(prefix: string): string {
  return Array.from({ length: 40 }, (_, i) => `${prefix} paragraph ${i} — filler text so the page is tall enough to scroll.`).join('\n\n');
}

test('mobile presence card: narrow layout, no legacy pre-title row, and a stable reading position across enter/exit', async ({ browser, userBPage }) => {
  const readerContext = await browser.newContext({ storageState: storageStatePath.userA, viewport: VIEWPORT_320 });
  const reader = await readerContext.newPage();

  const pagePath = `/e2e/mobile-presence/${Date.now()}`;
  await createPageViaApi(readerContext, {
    path: pagePath,
    body: `# Mobile presence card\n\n${bodyParagraphs('Intro')}\n\n## Reading anchor\n\n${bodyParagraphs('Tail')}\n`,
  });

  await reader.goto(pagePath);
  const expandedHeader = reader.getByTestId('page-header-expanded');
  await expect(expandedHeader).toBeVisible();

  await test.step('320px: the pre-title presence/TOC row is not rendered, and nothing overflows horizontally', async () => {
    // AC: "旧来の title 前 outer row はモバイルで描画されない (display:none
    // ではなく非描画)" — asserted as absence from the DOM, which `hidden
    // md:flex` would NOT satisfy.
    await expect(reader.getByTestId('presence-toc-row-desktop')).toHaveCount(0);
    await expect(reader.getByTestId('live-presence-row')).toHaveCount(0);

    const overflow = await reader.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal overflow at 320px').toBeLessThanOrEqual(0);
  });

  await reader.setViewportSize(VIEWPORT_375);

  // The expanded card lives inside the sticky-header placeholder, which
  // goes `aria-hidden` + `inert` once the header compacts — so it must be
  // reached structurally, not by role: `getByRole` deliberately ignores
  // `aria-hidden` subtrees, which is correct behaviour for a11y queries
  // and exactly wrong for "is the collapsed slot mounted".
  const cardButton = reader.locator('[data-testid="mobile-presence-card-slot"] button');

  await test.step('375px: self-only collapses the card away, and the slot sits last in the expanded header', async () => {
    // Only userA is here, so the card must be collapsed (the animated
    // track stays, its content does not).
    await expect(cardButton).toHaveCount(0);

    const order = await reader.evaluate(() => {
      const header = document.querySelector('[data-testid="page-header-expanded"]');
      const title = header?.querySelector('h1') ?? null;
      // The author/updated group's "… に更新" link — a stable marker for
      // the meta group that precedes the statistics chips.
      const updated = header?.querySelector('a[href^="/_history"]') ?? null;
      const slot = header?.querySelector('[data-testid="mobile-presence-card-slot"]') ?? null;
      const follows = (a: Element | null, b: Element | null) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        hasAll: Boolean(title && updated && slot),
        titleThenMeta: follows(title, updated),
        metaThenSlot: follows(updated, slot),
        // Everything else in the expanded header (title, meta group,
        // statistics chips) precedes the slot, so "last child" is the
        // whole `title → author/updated → statistics → card` order.
        slotIsLast: header?.lastElementChild?.getAttribute('data-testid') === 'mobile-presence-card-slot',
      };
    });
    expect(order).toEqual({ hasAll: true, titleThenMeta: true, metaThenSlot: true, slotIsLast: true });
  });

  // Put the reader mid-article, past the header, which is where the AC's
  // "reading position must not jump" applies.
  const anchor = reader.getByRole('heading', { name: 'Reading anchor' });
  await anchor.scrollIntoViewIfNeeded();
  await reader.evaluate(() => window.scrollBy(0, -150));
  await reader.waitForTimeout(SETTLE_MS);
  expect(await reader.evaluate(() => window.scrollY), 'the reader is scrolled past the header').toBeGreaterThan(400);

  await test.step('a second viewer joining expands the card without moving the body under the reader', async () => {
    const before = await anchor.boundingBox();
    await userBPage.goto(pagePath);

    await expect(cardButton).toHaveCount(1, { timeout: PRESENCE_TIMEOUT_MS });
    await reader.waitForTimeout(SETTLE_MS);

    const after = await anchor.boundingBox();
    expect(before && after).toBeTruthy();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0)), 'reading position after the card entered').toBeLessThanOrEqual(2);
  });

  await test.step('the compact bar shows the short trigger instead of a second card', async () => {
    const compactBar = reader.getByTestId('page-header-compact');
    await expect(compactBar).toBeVisible();
    await expect(compactBar.getByRole('button', { name: CARD_LABEL })).toHaveCount(1);
    await expect(compactBar.getByTestId('mobile-presence-card-slot')).toHaveCount(0);
    expect(await compactBar.evaluate((el) => Math.round(el.getBoundingClientRect().height)), 'compact bar stays 60px').toBe(60);
  });

  await test.step('that viewer leaving collapses the card, again without moving the body', async () => {
    const before = await anchor.boundingBox();
    await userBPage.close();

    await expect(cardButton).toHaveCount(0, { timeout: PRESENCE_TIMEOUT_MS });
    await reader.waitForTimeout(SETTLE_MS);

    const after = await anchor.boundingBox();
    expect(before && after).toBeTruthy();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0)), 'reading position after the card exited').toBeLessThanOrEqual(2);
  });

  await readerContext.close();
});
