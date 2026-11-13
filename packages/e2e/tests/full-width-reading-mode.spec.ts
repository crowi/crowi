import type { BrowserContext, Page } from '@playwright/test';
import { accessTokenFromContext, createPageViaApi, getPageLatestRevisionId, updatePageViaApi } from '../src/api';
import { E2E_API_URL, E2E_WEB_URL } from '../src/config';
import { expect, test } from '../src/fixtures';

const STORAGE_KEY = 'crowi:reading-width:v1';
const VIEWPORT_HEIGHT = 900;
const ROUNDING_PX = 1;
const LEFT_GUTTER_PX = 40; // 2.5rem
const RIGHT_GUTTER_PX = 16; // 1rem

const EXPAND_NAME = /Read at full width|全幅で読む/;
const RESTORE_NAME = /Restore standard width|標準幅に戻す/;

const NORMAL_TOGGLE = '[data-reading-expanded-header] [data-reading-width-toggle]';
const COMPACT_TOGGLE = '[data-reading-compact-header] [data-reading-width-toggle]';
const CONTENT = '[data-reading-width-scope="page"] [data-reading-content]';

function casePath(name: string): string {
  return `/e2e/full-width-reading-mode/${Date.now()}-${name}`;
}

function wideTable(label: string): string {
  const cols = Array.from({ length: 12 }, (_, i) => `${label}${i + 1}`);
  const row = (prefix: string) => `| ${cols.map((c) => `${prefix}-${c}-cell-text`).join(' | ')} |`;
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, row('a'), row('b')].join('\n');
}

const LONG_PARAGRAPH = Array.from(
  { length: 24 },
  (_, i) => `Sentence ${i + 1} wraps across the column so the reading width changes where the line breaks fall.`,
).join(' ');

function fixtureBody(linkPath: string): string {
  return [
    '## First section',
    LONG_PARAGRAPH,
    wideTable('A'),
    '## Second section',
    LONG_PARAGRAPH,
    LONG_PARAGRAPH,
    wideTable('B'),
    '## Third section',
    LONG_PARAGRAPH,
    LONG_PARAGRAPH,
    LONG_PARAGRAPH,
    `[next page](${linkPath})`,
    LONG_PARAGRAPH,
    LONG_PARAGRAPH,
    LONG_PARAGRAPH,
  ].join('\n\n');
}

async function seedPages(page: Page, name: string): Promise<{ target: string; other: string }> {
  const base = casePath(name);
  const other = `${base}/other`;
  const target = `${base}/target`;
  await createPageViaApi(page.context(), { path: other, body: '# Other\n\nNo headings here, only a short note.\n' });
  await createPageViaApi(page.context(), { path: target, body: fixtureBody(other) });
  return { target, other };
}

/** Writes the stored preference from a document of the app's origin, before the real visit. */
async function presetStorage(page: Page, value: 'standard' | 'full' | null): Promise<void> {
  await page.goto('/favicon.ico');
  await page.evaluate(
    ([key, next]) => {
      if (next === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    },
    [STORAGE_KEY, value] as const,
  );
}

async function storedPreference(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

interface Geometry {
  clientWidth: number;
  scrollWidth: number;
  content: { left: number; right: number; width: number };
}

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate((selector) => {
    const root = document.documentElement;
    const rect = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      content: { left: rect.left, right: rect.right, width: rect.width },
    };
  }, CONTENT);
}

async function openPage(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.goto(path);
  await expect(page.locator(CONTENT)).toBeVisible();
}

async function scrollInstantly(page: Page, top: number): Promise<void> {
  // The document sets `scroll-behavior: smooth`; an instant jump keeps the measurements deterministic.
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
}

async function activeElementInfo(page: Page): Promise<{ id: string; toggle: boolean; label: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { id: el?.id ?? '', toggle: el?.hasAttribute('data-reading-width-toggle') ?? false, label: el?.getAttribute('aria-label') ?? null };
  });
}

async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: E2E_WEB_URL });
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('full width reading mode', () => {
  test('T-8: geometry, headers and return to standard across breakpoints', async ({ userAPage }) => {
    test.setTimeout(180_000);
    await grantClipboard(userAPage.context());
    const { target } = await seedPages(userAPage, 't8');
    await presetStorage(userAPage, null);

    for (const width of [767, 768, 960, 1024, 1279, 1280, 1439, 1440, 1920]) {
      await openPage(userAPage, target, width);
      const toggle = userAPage.locator(NORMAL_TOGGLE);
      const standard = await measure(userAPage);

      if (width < 768) {
        await expect(toggle).toBeHidden();
        expect(standard.scrollWidth).toBeLessThanOrEqual(standard.clientWidth + ROUNDING_PX);
        // Small screens keep a scrollport on the table itself.
        const overflow = await userAPage.evaluate(() => {
          const table = document.querySelector('table') as HTMLElement;
          const port = table.parentElement as HTMLElement;
          return { overflowX: getComputedStyle(port).overflowX, scrolls: port.scrollWidth > port.clientWidth };
        });
        expect(overflow.overflowX).toBe('auto');
        expect(overflow.scrolls).toBe(true);
        continue;
      }

      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toHaveAccessibleName(RESTORE_NAME);

      const full = await measure(userAPage);
      expect(full.content.left).toBeGreaterThanOrEqual(LEFT_GUTTER_PX - ROUNDING_PX);
      expect(full.content.left).toBeLessThanOrEqual(LEFT_GUTTER_PX + ROUNDING_PX);
      expect(Math.abs(full.content.right - (full.clientWidth - RIGHT_GUTTER_PX))).toBeLessThanOrEqual(ROUNDING_PX);
      // Below ~900px the standard column already fills the viewport with 1rem gutters, so the 2.5rem link gutter makes full narrower there.
      if (width >= 1024) expect(full.content.width).toBeGreaterThan(standard.content.width);
      expect(full.scrollWidth).toBeLessThanOrEqual(full.clientWidth + ROUNDING_PX);
      await expect(userAPage.locator('[data-reading-right-rail]')).toBeHidden();
      await expect(userAPage.locator('[data-reading-left-rail]')).toBeHidden();

      // The app header row lines up with the body column's text edge.
      const appRow = await userAPage.evaluate(() => {
        const row = document.querySelector('.crowi-reading-app-row') as HTMLElement;
        const style = getComputedStyle(row);
        return { left: row.getBoundingClientRect().left, paddingLeft: Number.parseFloat(style.paddingLeft), maxWidth: style.maxWidth };
      });
      expect(appRow.maxWidth).toBe('none');
      expect(Math.abs(appRow.left + appRow.paddingLeft - full.content.left)).toBeLessThanOrEqual(ROUNDING_PX);

      // The heading link's copy button hangs 28px left of the text and must stay whole and clickable.
      const heading = userAPage.locator(`${CONTENT} h2`).first();
      await heading.hover();
      const copyLink = heading.getByRole('button', { name: /Copy link to this section/ });
      await expect(copyLink).toBeVisible();
      const copyBox = await copyLink.boundingBox();
      expect(copyBox).not.toBeNull();
      expect(copyBox?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((copyBox?.x ?? 0) + (copyBox?.width ?? 0)).toBeLessThanOrEqual(full.clientWidth);
      await copyLink.click();
      const headingId = await heading.getAttribute('id');
      await expect.poll(() => readClipboard(userAPage)).toMatch(new RegExp(`#${headingId}$`));

      // Compact header: every control sits inside the viewport and the way back to the top works.
      await scrollInstantly(userAPage, 1200);
      const compactHeader = userAPage.locator('[data-reading-compact-header]');
      await expect(compactHeader).toBeVisible();
      const boxes = await compactHeader.locator('button:visible').evaluateAll((buttons) =>
        buttons.map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.getAttribute('aria-label') ?? b.textContent ?? '', left: r.left, right: r.right };
        }),
      );
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box.left, `${width}px: ${box.label}`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${width}px: ${box.label}`).toBeLessThanOrEqual(full.clientWidth + ROUNDING_PX);
      }
      const leading = await userAPage.evaluate(() => {
        const el = document.querySelector('[data-reading-compact-header] .crowi-reading-leading-controls') as HTMLElement;
        return getComputedStyle(el).position;
      });
      expect(leading).toBe('static');
      if (width >= 1440) await expect(compactHeader.locator('.crowi-reading-sidebar-trigger')).toBeHidden();
      const compactRow = await userAPage.locator('.crowi-reading-compact-row').boundingBox();
      expect(compactRow?.x ?? -1).toBeGreaterThanOrEqual(0);
      await compactHeader.getByRole('button', { name: /scroll|top|先頭/i }).click();
      await expect.poll(() => userAPage.evaluate(() => window.scrollY)).toBeLessThan(5);
      await expect(compactHeader).toBeHidden();

      // Back to standard: the pre-switch geometry returns.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const restored = await measure(userAPage);
      expect(Math.abs(restored.content.width - standard.content.width)).toBeLessThanOrEqual(ROUNDING_PX);
      expect(Math.abs(restored.content.left - standard.content.left)).toBeLessThanOrEqual(ROUNDING_PX);
    }
  });

  test('T-9: persistence across SPA navigation, reload, a second tab and storage failures', async ({ userAPage }) => {
    const { target, other } = await seedPages(userAPage, 't9');
    await presetStorage(userAPage, null);
    await openPage(userAPage, target, 1440);
    const standard = await measure(userAPage);

    await userAPage.locator(NORMAL_TOGGLE).click();
    await expect.poll(() => storedPreference(userAPage)).toBe('full');

    // SPA navigation to another page keeps the choice.
    await userAPage.getByRole('link', { name: 'next page' }).click();
    await expect(userAPage).toHaveURL(new RegExp(`${other}$`));
    await expect(userAPage.locator(NORMAL_TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    const wideOther = await measure(userAPage);
    expect(wideOther.content.width).toBeGreaterThan(standard.content.width);

    // Reload and a new tab of the same browser read the saved value.
    await userAPage.reload();
    await expect(userAPage.locator(NORMAL_TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    const second = await userAPage.context().newPage();
    await second.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
    await second.goto(target);
    await expect(second.locator(NORMAL_TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    await second.close();

    // An unknown stored value is the standard width and is not rewritten.
    await presetStorage(userAPage, null);
    await userAPage.evaluate((key) => window.localStorage.setItem(key, 'bogus'), STORAGE_KEY);
    await openPage(userAPage, target, 1440);
    await expect(userAPage.locator(NORMAL_TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await storedPreference(userAPage)).toBe('bogus');
    await presetStorage(userAPage, null);
  });

  test('T-9: the first visible body frame already has the saved width, without hydration errors', async ({ userAPage }) => {
    const { target } = await seedPages(userAPage, 't9-first-frame');
    await presetStorage(userAPage, 'full');
    const problems: string[] = [];
    userAPage.on('pageerror', (error) => problems.push(error.message));
    userAPage.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    await userAPage.addInitScript((selector) => {
      const w = window as unknown as { __firstFrame?: { width: number; clientWidth: number } };
      const sample = () => {
        if (w.__firstFrame) return;
        const el = document.querySelector(selector) as HTMLElement | null;
        const rect = el?.getBoundingClientRect();
        if (el && rect && rect.width > 0) w.__firstFrame = { width: rect.width, clientWidth: document.documentElement.clientWidth };
      };
      const tick = () => {
        sample();
        if (!w.__firstFrame) requestAnimationFrame(tick);
      };
      new MutationObserver(sample).observe(document, { childList: true, subtree: true });
      requestAnimationFrame(tick);
    }, CONTENT);
    await userAPage.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
    await userAPage.goto(target);
    await expect(userAPage.locator(CONTENT)).toBeVisible();

    const first = await userAPage.evaluate(() => (window as unknown as { __firstFrame?: { width: number; clientWidth: number } }).__firstFrame);
    expect(first).toBeDefined();
    // Full width: the column spans the viewport minus the two gutters from its very first frame.
    expect(Math.abs((first?.width ?? 0) - ((first?.clientWidth ?? 0) - LEFT_GUTTER_PX - RIGHT_GUTTER_PX))).toBeLessThanOrEqual(ROUNDING_PX);
    expect(problems.filter((p) => /hydrat/i.test(p))).toEqual([]);
    await presetStorage(userAPage, null);
  });

  test('T-9: reading or writing storage can fail and the toggle still works for the open document', async ({ userAPage }) => {
    const { target } = await seedPages(userAPage, 't9-storage-failure');
    await presetStorage(userAPage, null);
    await userAPage.addInitScript((key) => {
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (this: Storage, name: string) {
        if (name === key) throw new DOMException('blocked', 'SecurityError');
        return getItem.call(this, name);
      };
      Storage.prototype.setItem = function (this: Storage, name: string, value: string) {
        if (name === key) throw new DOMException('quota', 'QuotaExceededError');
        return setItem.call(this, name, value);
      };
    }, STORAGE_KEY);
    await openPage(userAPage, target, 1440);
    const standard = await measure(userAPage);
    const toggle = userAPage.locator(NORMAL_TOGGLE);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect((await measure(userAPage)).content.width).toBeGreaterThan(standard.content.width);
  });

  test('T-10: keyboard, popover, small screens, TOC, copy and table enlargement', async ({ userAPage }) => {
    test.setTimeout(120_000);
    await grantClipboard(userAPage.context());
    const { target } = await seedPages(userAPage, 't10');
    await presetStorage(userAPage, null);
    await openPage(userAPage, target, 1440);
    const toggle = userAPage.locator(NORMAL_TOGGLE);

    // Enter and Space both toggle; Escape never restores the width.
    await toggle.focus();
    await userAPage.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userAPage.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await storedPreference(userAPage)).toBe('full');
    await userAPage.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userAPage.keyboard.press('Tab');
    expect((await activeElementInfo(userAPage)).toggle).toBe(false);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // TOC: reachable at the full width, jumps to the heading, closes on navigation.
    const tocControl = userAPage.locator('[data-reading-expanded-header] [data-reading-toc-control] button');
    await tocControl.click();
    await userAPage.getByRole('link', { name: 'Second section' }).click();
    await expect(userAPage).toHaveURL(/#second-section$/);
    await expect(userAPage.getByRole('link', { name: 'Second section' })).toHaveCount(0);

    // Markdown copy from the current version uses the existing menu.
    // Reopen without the hash so the body does not scroll to the heading again on later layout changes.
    await userAPage.goto(target);
    await expect(userAPage.locator(CONTENT)).toBeVisible();
    await scrollInstantly(userAPage, 0);
    await expect(userAPage.locator('[data-reading-expanded-header]').getByRole('button', { name: 'Copy markdown' })).toHaveCount(0);

    // A popover left open while returning to the standard width is closed, not stranded.
    await tocControl.click();
    await expect(userAPage.getByRole('link', { name: 'Third section' })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(userAPage.getByRole('link', { name: 'Third section' }).locator('visible=true')).toHaveCount(1); // the rail's list is back
    await expect(userAPage.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
    expect((await activeElementInfo(userAPage)).toggle).toBe(true);
    await scrollInstantly(userAPage, 0);

    // Becoming a small screen while the toggle holds focus hands focus to <main>.
    await userAPage.setViewportSize({ width: 700, height: VIEWPORT_HEIGHT });
    await expect(toggle).toBeHidden();
    await expect.poll(() => activeElementInfo(userAPage).then((i) => i.id)).toBe('main-content');
    await userAPage.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
    // The reflow can move the scroll position; wait until the normal header is back on screen.
    await expect
      .poll(async () => {
        await scrollInstantly(userAPage, 0);
        return toggle.isVisible();
      })
      .toBe(true);

    // Tables: enlarging and closing keeps each table's own horizontal scroll position.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const tables = userAPage.locator(`${CONTENT} table`);
    await expect(tables).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
      await tables.nth(i).scrollIntoViewIfNeeded();
      // The inline scrollport may only scroll a little; the dialog has to carry whatever was actually reached.
      const inlineLeft = await tables.nth(i).evaluate((table) => {
        const port = table.parentElement as HTMLElement;
        port.scrollLeft = 120;
        return port.scrollLeft;
      });
      expect(inlineLeft).toBeGreaterThan(0);
      const expand = userAPage.getByRole('button', { name: 'Expand table' }).nth(i);
      await expand.click();
      const dialog = userAPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // The enlarged table opens at the position the reader had scrolled to (as far as the roomier dialog can scroll).
      const carried = await dialog.locator('table').evaluate((table) => {
        const port = table.parentElement as HTMLElement;
        return { scrollLeft: port.scrollLeft, max: port.scrollWidth - port.clientWidth };
      });
      expect(carried.scrollLeft).toBe(Math.min(inlineLeft, carried.max));
      await userAPage.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(tables).toHaveCount(2);
      expect(await storedPreference(userAPage)).toBe('full');
      const overflow = await measure(userAPage);
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + ROUNDING_PX);
    }
    await presetStorage(userAPage, null);
  });

  test('T-10: a past revision keeps its Markdown copy reachable from the header at full width', async ({ userAPage }) => {
    await grantClipboard(userAPage.context());
    const path = `${casePath('t10-revision')}/page`;
    const oldBody = '## Old heading\n\nOLD-REVISION-BODY-MARKER\n\n## Another\n\ntext\n';
    const pageId = await createPageViaApi(userAPage.context(), { path, body: oldBody });
    const oldRevisionId = await getPageLatestRevisionId(userAPage.context(), pageId);
    await updatePageViaApi(userAPage.context(), { pageId, body: '## New heading\n\nCURRENT-BODY-MARKER\n\n## Another\n\ntext\n' });

    await presetStorage(userAPage, 'full');
    await userAPage.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
    await userAPage.goto(`${path}?revision_id=${oldRevisionId}`);
    await expect(userAPage.getByText('OLD-REVISION-BODY-MARKER').first()).toBeVisible();
    const headerCopy = userAPage.locator('header [data-reading-expanded-header]').getByRole('button', { name: 'Copy markdown' });
    await expect(headerCopy).toBeVisible();
    await headerCopy.click();
    await expect.poll(() => readClipboard(userAPage)).toBe(oldBody);

    // At the standard width the right rail owns the button and the header has none.
    await userAPage.locator(NORMAL_TOGGLE).click();
    await expect(userAPage.locator('header [data-reading-expanded-header]').getByRole('button', { name: 'Copy markdown' })).toHaveCount(0);
    await expect(userAPage.locator('[data-reading-right-rail]').getByRole('button', { name: 'Copy markdown' })).toBeVisible();

    // The current version copies through the existing page menu, never a dedicated header button.
    await presetStorage(userAPage, 'full');
    await userAPage.goto(path);
    await expect(userAPage.getByText('CURRENT-BODY-MARKER').first()).toBeVisible();
    await expect(userAPage.locator('header [data-reading-expanded-header]').getByRole('button', { name: 'Copy markdown' })).toHaveCount(0);
    await presetStorage(userAPage, null);
  });

  test('T-10: returning to the standard width from the compact bar hands focus to the normal toggle', async ({ userAPage }) => {
    const base = casePath('t10-handoff');
    const longTitle = 'A deliberately long page title that fits one line at full width yet wraps in the standard column';
    const path = `${base}/${longTitle}`;
    await createPageViaApi(userAPage.context(), { path, body: fixtureBody(`${base}/missing`) });
    await presetStorage(userAPage, 'full');
    await openPage(userAPage, path, 1280);

    const headerHeight = () => userAPage.locator('[data-reading-expanded-header]').evaluate((el) => (el as HTMLElement).offsetHeight);
    const fullHeight = await headerHeight();
    await userAPage.locator(NORMAL_TOGGLE).click();
    await expect.poll(headerHeight).toBeGreaterThan(fullHeight + 5);
    const standardHeight = await headerHeight();
    await userAPage.locator(NORMAL_TOGGLE).click();
    await expect.poll(headerHeight).toBe(fullHeight);

    // Between the two measured heights: compact at the full width, expanded at the standard one.
    await scrollInstantly(userAPage, fullHeight + 3);
    expect(fullHeight + 3).toBeLessThan(standardHeight);
    await expect(userAPage.locator('[data-reading-compact-header]')).toBeVisible();
    await userAPage.locator(COMPACT_TOGGLE).click();
    await expect(userAPage.locator('[data-reading-compact-header]')).toHaveCount(0);
    await expect.poll(() => activeElementInfo(userAPage)).toMatchObject({ toggle: true, label: expect.stringMatching(EXPAND_NAME) });
    await presetStorage(userAPage, null);
  });

  test('T-11: other screens keep their widths and the page keeps its URL and revision', async ({ userAPage, userBPage }) => {
    test.setTimeout(120_000);
    const base = casePath('t11');
    const path = `${base}/page`;
    const pageId = await createPageViaApi(userAPage.context(), { path, body: '## One\n\nfirst version\n\n## Two\n\ntext\n' });
    const revisionId = await getPageLatestRevisionId(userAPage.context(), pageId);
    await updatePageViaApi(userAPage.context(), { pageId, body: '## One\n\nsecond version\n\n## Two\n\ntext\n' });
    await createPageViaApi(userAPage.context(), { path: `${base}/portal/`, body: '# Portal\n\n## A\n\ntext\n\n## B\n\ntext\n' });
    const blockedPath = `${base}/owner-only`;
    await createPageViaApi(userBPage.context(), { path: blockedPath, body: 'E2E-OWNER-ONLY-BODY-MARKER', grant: 4 });

    await presetStorage(userAPage, 'full');
    await userAPage.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });

    const mainWidth = () => userAPage.locator('.crowi-reading-main').evaluate((el) => el.getBoundingClientRect().width);
    const columnsWidth = () =>
      userAPage.evaluate(() => {
        const columns = document.querySelector('[data-toc-columns]') as HTMLElement | null;
        return columns ? (columns.querySelector('[data-reading-content]') as HTMLElement).getBoundingClientRect().width : null;
      });
    const MAX_PROSE = 54 * 16 + 1;
    const MAX_MAIN = 56 * 16 + 1;

    await userAPage.goto(`${base}/portal/`);
    await expect(userAPage.locator('[data-toc-columns]')).toBeVisible();
    await expect(userAPage.locator('[data-reading-width-scope="page"]')).toHaveCount(0);
    await expect(userAPage.locator('[data-reading-width-toggle]')).toHaveCount(0);
    expect(await columnsWidth()).toBeLessThanOrEqual(MAX_PROSE);

    for (const other of [`/_search?q=full-width`, `/_edit?page_id=${pageId}`, `/_history?page_id=${pageId}`]) {
      await userAPage.goto(other);
      await expect(userAPage.locator('[data-reading-width-scope="page"]')).toHaveCount(0);
      await expect(userAPage.locator('[data-reading-width-toggle]')).toHaveCount(0);
    }
    await userAPage.goto('/_search?q=full-width');
    await expect(userAPage.locator('.crowi-reading-main')).toBeVisible();
    expect(await mainWidth()).toBeLessThanOrEqual(MAX_MAIN);

    await userAPage.goto(blockedPath);
    await expect(userAPage.locator('[data-reading-width-scope="page"]')).toHaveCount(0);
    await expect(userAPage.getByText('E2E-OWNER-ONLY-BODY-MARKER')).toHaveCount(0);
    await expect(userAPage.locator('[data-reading-width-toggle]')).toHaveCount(0);

    // A target page again: width follows the preference, while URL and revision stay put.
    const url = `${path}?revision_id=${revisionId}#two`;
    await userAPage.goto(url);
    await expect(userAPage.getByText('first version').first()).toBeVisible();
    const before = userAPage.url();
    const toggle = userAPage.locator(NORMAL_TOGGLE);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await toggle.click();
    expect(userAPage.url()).toBe(before);
    await expect(userAPage.getByText('first version').first()).toBeVisible();
    await expect(userAPage.getByText('second version')).toHaveCount(0);
    await presetStorage(userAPage, null);
  });

  test('T-12: print layout is the same for both widths and the title survives a compact header', async ({ userAPage, adminPage }) => {
    test.setTimeout(120_000);
    const { target } = await seedPages(userAPage, 't12');
    const accessToken = await accessTokenFromContext(adminPage.context());
    const adminHeaders = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
    const before = (await (await fetch(`${E2E_API_URL}/api/admin/app`, { headers: adminHeaders })).json()) as { app?: { confidential?: string } };
    const originalConfidential = before.app?.confidential ?? '';
    try {
      const put = await fetch(`${E2E_API_URL}/api/admin/app`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ app: { confidential: 'E2E confidential' } }),
      });
      expect(put.ok).toBe(true);

      const printed: Record<string, { content: number; compactDisplay: string; title: string; titleHeight: number }> = {};
      for (const preference of ['standard', 'full'] as const) {
        await presetStorage(userAPage, preference);
        await openPage(userAPage, target, 1440);
        await expect(userAPage.getByText('E2E confidential').locator('visible=true').first()).toBeVisible();

        // Scroll until the compact bar shows and the measured header is `invisible` on screen.
        await scrollInstantly(userAPage, 1200);
        await expect(userAPage.locator('[data-reading-compact-header]')).toBeVisible();
        expect(await userAPage.locator('[data-reading-expanded-header]').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');

        await userAPage.emulateMedia({ media: 'print' });
        printed[preference] = await userAPage.evaluate((selector) => {
          const content = document.querySelector(selector) as HTMLElement;
          const compact = document.querySelector('[data-reading-compact-header]') as HTMLElement | null;
          const title = document.querySelector('[data-reading-expanded-header] h1') as HTMLElement;
          return {
            content: Math.round(content.getBoundingClientRect().width),
            compactDisplay: compact ? getComputedStyle(compact).display : 'none',
            title: getComputedStyle(title).visibility,
            titleHeight: title.getBoundingClientRect().height,
          };
        }, CONTENT);
        await expect(userAPage.locator('[data-reading-right-rail]')).toBeHidden();
        await expect(userAPage.locator('[data-reading-left-rail]')).toBeHidden();
        await expect(userAPage.locator('[data-reading-width-toggle]').locator('visible=true')).toHaveCount(0);
        await expect(userAPage.getByText('E2E confidential').locator('visible=true').first()).toBeVisible();
        expect(await storedPreference(userAPage)).toBe(preference);
        await userAPage.emulateMedia({ media: 'screen' });
      }

      expect(printed.standard.compactDisplay).toBe('none');
      expect(printed.full.compactDisplay).toBe('none');
      expect(printed.standard.title).toBe('visible');
      expect(printed.full.title).toBe('visible');
      expect(printed.standard.titleHeight).toBeGreaterThan(0);
      expect(Math.abs(printed.standard.content - printed.full.content)).toBeLessThanOrEqual(ROUNDING_PX);
    } finally {
      await fetch(`${E2E_API_URL}/api/admin/app`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ app: { confidential: originalConfidential } }),
      });
      await presetStorage(userAPage, null);
    }
  });
});
