import type { Locator, Page } from '@playwright/test';
import { createPageViaApi, getPageBody, updatePageViaApi, uploadAttachmentViaApi } from '../src/api';
import { forceStaleRendererVersion } from '../src/db';
import { expect, test } from '../src/fixtures';
import { EditorPage } from '../src/pages/editor-page';

/**
 * feature-html-sanitizer-web Phase 3 — browser corpus for the strict HTML
 * boundary. Every case saves a real page body through the API, then asserts the
 * final DOM of the page view (and, where noted, the editor preview) plus the
 * invariants a DOM-level unit test cannot see: no handler fired, no dialog, no
 * unexpected request, and the stored body unchanged.
 */

/** Window counter + dialog/navigation monitor installed before the page's own scripts run. */
async function installFireMonitor(page: Page): Promise<{ dialogs: string[]; requests: string[] }> {
  const dialogs: string[] = [];
  const requests: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('e2e-forbidden.invalid')) requests.push(url);
  });
  await page.addInitScript(() => {
    (window as unknown as { __sanitizerFired: number }).__sanitizerFired = 0;
  });
  return { dialogs, requests };
}

async function firedCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __sanitizerFired?: number }).__sanitizerFired ?? 0);
}

/** Run the same assertions against the saved page view and the editor preview pane. */
async function onBothSurfaces(page: Page, pageId: string, path: string, check: (prose: Locator, surface: 'page' | 'preview') => Promise<void>): Promise<void> {
  await page.goto(path);
  const pageProse = page.locator('.crowi-prose').first();
  await expect(pageProse).toBeVisible();
  await check(pageProse, 'page');
  const editor = new EditorPage(page);
  await editor.openSharedPage(pageId);
  const previewProse = page.locator('.crowi-prose').first();
  await expect(previewProse).toBeVisible({ timeout: 30_000 });
  await check(previewProse, 'preview');
}

/** Document order of the given texts inside `prose` (a failed lookup yields -1 and fails the ordering). */
async function expectTextOrder(prose: Locator, texts: string[]): Promise<void> {
  const text = (await prose.textContent()) ?? '';
  const positions = texts.map((t) => text.indexOf(t));
  for (const [i, pos] of positions.entries()) expect(pos, `${texts[i]} present`).toBeGreaterThanOrEqual(0);
  expect(positions, `order of ${texts.join(' < ')}`).toEqual([...positions].sort((a, b) => a - b));
}

/** The nonce / carrier machinery must never leak into the DOM as an attribute value or text. */
async function expectNoNonceLeak(prose: Locator): Promise<void> {
  const leaked = await prose.evaluate((root) => {
    const hex = /(^|[^0-9a-f])[0-9a-f]{32}($|[^0-9a-f])/;
    const found: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) if (hex.test(attr.value)) found.push(`${el.tagName}[${attr.name}]`);
    }
    if (hex.test(root.textContent ?? '')) found.push('text');
    return found;
  });
  expect(leaked).toEqual([]);
}

async function expectNoFailureUi(page: Page): Promise<void> {
  await expect(page.getByText(/Rendering failed|表示に失敗/)).toHaveCount(0);
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');

const FIRE = 'window.__sanitizerFired=(window.__sanitizerFired||0)+1';

function newPath(label: string): string {
  return `/e2e/html-sanitizer/${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test.describe('html sanitizer (strict page and preview DOM)', () => {
  test('strict page and preview DOM: dangerous author HTML is inert and nothing fires', async ({ userAPage }) => {
    const monitor = await installFireMonitor(userAPage);
    const path = newPath('strict');
    const body = [
      '# strict corpus',
      '',
      `<img src="/e2e-img.png" alt="pic" onerror="${FIRE}" onload="${FIRE}" style="position:fixed">`,
      '',
      `<div id="evil-box" class="evil" style="color:red" onclick="${FIRE}">click-target</div>`,
      '',
      '<iframe src="https://e2e-forbidden.invalid/frame" srcdoc="<b>x</b>"></iframe>',
      '',
      `<script>${FIRE}</script>`,
      '',
      '<a href="https://example.com/ok" ping="https://e2e-forbidden.invalid/ping">ok-link</a>',
      '',
      '<img src="/a.png" srcset="https://e2e-forbidden.invalid/a.png 2x" alt="srcset">',
      '',
      '<p align="center">centered-readme</p>',
      '',
      '<ol type="a"><li>alpha</li></ol>',
      '',
      '<ruby>漢<rt>kan</rt></ruby>',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await userAPage.goto(path);
    await expect(userAPage.getByRole('heading', { name: 'strict corpus' })).toBeVisible();
    await expect(userAPage.getByText('click-target')).toBeVisible();

    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.locator('script, iframe, [onerror], [onload], [onclick], [srcdoc], [srcset], [ping]')).toHaveCount(0);
    await expect(prose.locator('img[alt="pic"]')).toHaveCount(1);
    await expect(prose.locator('img[alt="pic"]')).not.toHaveAttribute('style', /.+/);
    await expect(prose.getByText('click-target')).not.toHaveAttribute('class', /evil/);
    await expect(prose.getByText('click-target')).not.toHaveAttribute('style', /.+/);
    await expect(prose.getByText('click-target')).not.toHaveAttribute('onclick', /.*/);

    // README-style alignment is a DOM attribute, never generated style.
    const centered = prose.getByText('centered-readme');
    await expect(centered).toHaveAttribute('align', 'center');
    await expect(centered).not.toHaveAttribute('style', /.+/);
    await expect(prose.locator('ol[type="a"]')).toHaveCount(1);
    await expect(prose.locator('ruby rt')).toHaveText('kan');

    await prose.getByText('click-target').click();
    await userAPage.locator('img[alt="pic"]').first().dispatchEvent('error');
    expect(await firedCount(userAPage)).toBe(0);
    expect(monitor.dialogs).toEqual([]);
    expect(monitor.requests).toEqual([]);

    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
  });

  test('strict page and preview DOM: the editor preview applies the same strict boundary', async ({ userAPage }) => {
    const monitor = await installFireMonitor(userAPage);
    const path = newPath('preview');
    const body = [
      '# preview corpus',
      '',
      `<div class="evil" style="color:red" onclick="${FIRE}">preview-click-target</div>`,
      '',
      '<a href="javascript:alert(1)">preview-js-link</a>',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    const editor = new EditorPage(userAPage);
    await editor.openSharedPage(pageId);

    const target = userAPage.locator('.crowi-prose').getByText('preview-click-target').first();
    await expect(target).toBeVisible({ timeout: 30_000 });
    await expect(target).not.toHaveAttribute('class', /evil/);
    await expect(target).not.toHaveAttribute('style', /.+/);
    await expect(userAPage.locator('.crowi-prose').getByText('preview-js-link').first()).not.toHaveAttribute('href', /.+/);

    await target.click();
    expect(await firedCount(userAPage)).toBe(0);
    expect(monitor.dialogs).toEqual([]);
  });

  test('strict page and preview DOM: URL matrix keeps ordinary links and raster data images, drops dangerous schemes', async ({ userAPage }) => {
    const path = newPath('urls');
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const body = [
      '# url corpus',
      '',
      '[md-tel](tel:+81312345678) [md-file](file:///tmp/x) [md-slack](slack://open) [md-js](javascript:alert(1)) [md-data](data:text/html;base64,PGI+)',
      '',
      '<a href="tel:+81312345678">html-tel</a> <a href="file:///tmp/x">html-file</a> <a href="slack://open">html-slack</a> <a href="&#106;avascript:alert(1)">html-js</a> <a href="JaVaScRiPt:alert(1)">html-js-case</a> <a href="vbscript:x">html-vb</a>',
      '',
      `![md-png](${png})`,
      '',
      '![md-svg-alt](data:image/svg+xml;base64,PHN2Zy8+)',
      '',
      '[spaced](/Team/My Page)',
      '',
    ].join('\n');
    await createPageViaApi(userAPage.context(), { path, body });
    await userAPage.goto(path);

    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.getByRole('heading', { name: 'url corpus' })).toBeVisible();
    for (const [label, href] of [
      ['md-tel', 'tel:+81312345678'],
      ['md-file', 'file:///tmp/x'],
      ['md-slack', 'slack://open'],
      ['html-tel', 'tel:+81312345678'],
      ['html-file', 'file:///tmp/x'],
      ['html-slack', 'slack://open'],
    ] as const) {
      await expect(prose.getByText(label, { exact: true })).toHaveAttribute('href', href);
    }
    for (const label of ['md-js', 'md-data', 'html-js', 'html-js-case', 'html-vb']) {
      const link = prose.getByText(label, { exact: true });
      await expect(link).toBeVisible();
      await expect(link).not.toHaveAttribute('href', /.+/);
    }
    await expect(prose.locator('img[alt="md-png"]')).toHaveAttribute('src', png);
    await expect(prose.locator('img[alt="md-svg-alt"]')).toHaveCount(0);
    await expect(prose.getByText('md-svg-alt')).toBeVisible();
  });

  test('author attributes cannot activate renderer components', async ({ userAPage }) => {
    const path = newPath('forged');
    const body = [
      '# forged corpus',
      '',
      '<span class="mention" data-mention="x">forged-mention</span>',
      '',
      '<a class="wikilink-broken" href="/nowhere">forged-wikilink</a>',
      '',
      '<span role="img" aria-label="forged-label">forged-emoji</span>',
      '',
      '<section data-section-id="forged"><p>forged-section</p></section>',
      '',
      '<aside data-crowi-alert-variant="warning">forged-alert</aside>',
      '',
      '<figure class="crowi-figure crowi-image-float-right"><img src="/a.png" alt="forged-figure"></figure>',
      '',
    ].join('\n');
    await createPageViaApi(userAPage.context(), { path, body });
    await userAPage.goto(path);

    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.getByRole('heading', { name: 'forged corpus' })).toBeVisible();
    await expect(prose.getByText('forged-mention')).not.toHaveAttribute('class', /mention/);
    await expect(prose.getByText('forged-wikilink')).not.toHaveAttribute('class', /wikilink-broken/);
    await expect(prose.getByText('forged-emoji')).not.toHaveAttribute('role', /.+/);
    await expect(prose.getByText('forged-emoji')).not.toHaveAttribute('aria-label', /.+/);
    await expect(prose.locator('[data-section-id="forged"], [data-crowi-alert-variant]')).toHaveCount(0);
    await expect(prose.locator('figure.crowi-figure, figure.crowi-image-float-right')).toHaveCount(0);
  });

  test('unfinished-raw-before-code: unfinished raw tags degrade to text and the code block and later raw stay visible on page and preview', async ({
    userAPage,
  }) => {
    const code = (name: string) => ['```js', `const ${name} = 1;`, '```'].join('\n');
    const cases: Array<{ label: string; body: string; after: string }> = [
      { label: 'attr', body: ['<div title="note', '', code('attrCode'), '', '<p>after-attr</p>', ''].join('\n'), after: 'after-attr' },
      { label: 'col', body: ['<col>', '', '## col-heading', '', code('colCode'), '', 'col-after', ''].join('\n'), after: 'col-after' },
      // Alert children: a first raw chunk that ends without a newline separator.
      { label: 'pi', body: ['<div>', '<?php echo $x', '', code('piCode'), '', '<p>after-pi</p>', ''].join('\n'), after: 'after-pi' },
      { label: 'doctype', body: ['<div>', '<!DOCTYPE html', '', code('doctypeCode'), '', '<p>after-doctype</p>', ''].join('\n'), after: 'after-doctype' },
      { label: 'cdata', body: ['<div>', '<![CDATA[ x', '', code('cdataCode'), '', '<p>after-cdata</p>', ''].join('\n'), after: 'after-cdata' },
      { label: 'decl', body: ['<div>', '<!x', '', code('declCode'), '', '<p>after-decl</p>', ''].join('\n'), after: 'after-decl' },
      { label: 'closing', body: ['<div>', '</ x', '', code('closingCode'), '', '<p>after-closing</p>', ''].join('\n'), after: 'after-closing' },
      { label: 'comment', body: ['<div>', '<!-- x', '', code('commentCode'), '', '<p>after-comment</p>', ''].join('\n'), after: 'after-comment' },
      { label: 'amp', body: ['<div>', 'Q&A', '', code('ampCode'), '', '<p>after-amp</p>', ''].join('\n'), after: 'after-amp' },
    ];

    for (const { label, body, after } of cases) {
      await test.step(label, async () => {
        const path = newPath(`unfinished-${label}`);
        const pageId = await createPageViaApi(userAPage.context(), { path, body });
        await onBothSurfaces(userAPage, pageId, path, async (prose) => {
          await expect(prose.getByText(after)).toBeVisible();
          await expect(prose.locator('pre')).toContainText(`const ${label}Code = 1;`);
          await expectNoFailureUi(userAPage);
          await expectNoNonceLeak(prose);
        });
        expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
      });
    }
  });

  test('select-later-content: an unclosed select keeps the later heading, code and paragraph; a closed select is text only', async ({ userAPage }) => {
    const path = newPath('select');
    const body = [
      '<select>',
      '',
      '## select-heading',
      '',
      '```js',
      'const selectCode = 1;',
      '```',
      '',
      'select-after',
      '',
      '## select-second',
      '',
      'second-body',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });
    await onBothSurfaces(userAPage, pageId, path, async (prose, surface) => {
      await expect(prose.getByRole('heading', { name: 'select-heading' })).toBeVisible();
      await expect(prose.locator('pre')).toContainText('const selectCode = 1;');
      await expect(prose.locator('pre.shiki span[style*="--shiki-light"]').first()).toBeAttached();
      await expect(prose.getByText('select-after')).toBeVisible();
      await expectTextOrder(prose, ['<select>', 'select-heading', 'const selectCode = 1;', 'select-after']);
      if (surface === 'page') {
        const id = await prose.getByRole('heading', { name: 'select-heading' }).getAttribute('id');
        expect(id).toBeTruthy();
        await expect(userAPage.locator(`aside a[href="#${id}"]`).first()).toBeAttached();
        await userAPage.goto(`${path}#${id}`);
        await expect(userAPage.locator('section.is-target').first()).toBeVisible();
      }
    });

    const closedPath = newPath('select-closed');
    const closedId = await createPageViaApi(userAPage.context(), {
      path: closedPath,
      body: ['<select><option>closed-option</option></select>', '', '## closed-after-heading', '', '```js', 'const closedCode = 1;', '```', ''].join('\n'),
    });
    await onBothSurfaces(userAPage, closedId, closedPath, async (closedProse) => {
      await expect(closedProse.getByRole('heading', { name: 'closed-after-heading' })).toBeVisible();
      await expect(closedProse.locator('pre')).toContainText('const closedCode = 1;');
      await expect(closedProse.locator('select, option')).toHaveCount(0);
    });
  });

  test('structural-composition: generated blocks keep order and never nest into phrasing-only or anchor parents', async ({ userAPage }) => {
    const path = newPath('structural');
    const body = [
      '# structural corpus',
      '',
      'lead-p @[card](https://example.com) trail-p',
      '',
      '<article>',
      '',
      'article-pre',
      '',
      '@[card](https://example.com)',
      '',
      'article-post',
      '',
      '</article>',
      '',
      '<dl>',
      '<dd>',
      '',
      'dd-pre',
      '',
      'https://example.com/dd-bare',
      '',
      'dd-post',
      '',
      '</dd>',
      '</dl>',
      '',
      '<h3>h-open',
      '',
      '```js',
      'const headingBlock = 1;',
      '```',
      '',
      '</h3>',
      '',
      '<details><summary>sum-open',
      '',
      '```js',
      'const summaryBlock = 1;',
      '```',
      '',
      '</summary></details>',
      '',
      '<dl><dt>dt-open',
      '',
      '```js',
      'const dtBlock = 1;',
      '```',
      '',
      '</dt></dl>',
      '',
      '<a href="https://example.com/outer">outer-text <a href="https://example.com/inner">inner-text</a></a>',
      '',
      '<table><tr><td>',
      '',
      '$x^2$',
      '',
      '</td></tr></table>',
      '',
      '## table-A',
      '',
      '<table>',
      '',
      'para-X',
      '',
      '```js',
      'const tableCode = 1;',
      '```',
      '',
      'para-Y',
      '',
      '## table-B',
      '',
      'para-Z',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await onBothSurfaces(userAPage, pageId, path, async (prose, surface) => {
      await expect(prose.getByRole('heading', { name: 'structural corpus' })).toBeVisible();
      await expectNoFailureUi(userAPage);
      await expectNoNonceLeak(prose);

      await expectTextOrder(prose, ['lead-p', 'trail-p']);
      await expectTextOrder(prose, ['article-pre', 'article-post']);
      await expectTextOrder(prose, ['dd-pre', 'dd-post']);
      await expectTextOrder(prose, ['para-X', 'const tableCode = 1;', 'para-Y', 'table-B', 'para-Z']);

      // Phrasing-only parents never contain a generated block; the code block survives elsewhere.
      await expect(prose.locator('h1 pre, h2 pre, h3 pre, summary pre, dt pre')).toHaveCount(0);
      for (const name of ['headingBlock', 'summaryBlock', 'dtBlock']) await expect(prose.locator('pre', { hasText: `const ${name} = 1;` })).toHaveCount(1);
      await expect(prose.locator('p pre, p figure, p div.crowi-card')).toHaveCount(0);

      await expect(prose.locator('a a')).toHaveCount(0);
      await expect(prose.getByText('inner-text')).toBeVisible();
      await expect(prose.locator('td .katex')).toHaveCount(1);

      const tableB = prose.getByRole('heading', { name: 'table-B' });
      await expect(tableB).toBeVisible();
      if (surface === 'page') {
        const id = await tableB.getAttribute('id');
        expect(id).toBeTruthy();
        await expect(userAPage.locator(`aside a[href="#${id}"]`).first()).toBeAttached();
        await expect(prose.locator(`section[data-section-id="${id}"]`)).toHaveCount(1);
      }
    });
    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
  });

  test('card-heading-target: a heading holding a card keeps its id, TOC entry, hash scroll, section highlight and source line', async ({ userAPage }) => {
    const path = newPath('card-heading');
    const body = [
      '# card heading corpus',
      '',
      '## @[card](https://example.com) Setup',
      '',
      'setup-body',
      '',
      '## @[card](https://example.com)',
      '',
      'bare-body',
      '',
      ...Array.from({ length: 40 }, (_, i) => `filler ${i}\n`),
      '## card-tail',
      '',
      'tail-body',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });
    await userAPage.goto(path);
    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.getByRole('heading', { name: 'card heading corpus' })).toBeVisible();
    await expectNoFailureUi(userAPage);

    const headings = prose.locator('h2[id]');
    await expect(headings).toHaveCount(3);
    const ids = await headings.evaluateAll((els) => els.map((el) => el.id));
    for (const id of ids) {
      expect(id).toBeTruthy();
      await expect(userAPage.locator(`aside a[href="#${id}"]`).first()).toBeAttached();
      await expect(prose.locator(`section[data-section-id="${id}"]`)).toHaveCount(1);
    }

    await userAPage.goto(`${path}#${ids[2]}`);
    await expect(userAPage.locator(`#${ids[2]}`)).toBeInViewport();
    await userAPage.goto(`${path}#${ids[0]}`);
    await expect(userAPage.locator('section.is-target').first()).toBeVisible();
    await userAPage.goto(`${path}#${ids[1]}`);
    await expect(userAPage.locator('section.is-target').first()).toBeVisible();

    // The preview stamps the source line used for scroll sync on every heading.
    await new EditorPage(userAPage).openSharedPage(pageId);
    const previewHeadings = userAPage.locator('.crowi-prose').first().locator('h2');
    await expect(previewHeadings).toHaveCount(3);
    expect(await previewHeadings.evaluateAll((els) => els.map((el) => el.hasAttribute('data-source-line')))).toEqual([true, true, true]);
    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
  });

  test('strict page and preview DOM: classification, literal text, additional tag attributes and title-split content', async ({ userAPage }) => {
    const path = newPath('classify');
    const body = [
      '# classify corpus',
      '',
      '<object data="https://e2e-forbidden.invalid/o">obj-text</object>',
      '',
      '<form action="https://e2e-forbidden.invalid/f"><input type="text">form-text</form>',
      '',
      '<template>tmpl-text</template>',
      '',
      '<svg><circle r="1"/></svg>',
      '',
      '<math><mi>x</mi></math>',
      '',
      '<applet code="X">applet-text</applet>',
      '',
      'ssh <user>@<host> ssh-literal',
      '',
      'No <thing> yet thing-literal',
      '',
      '<ol start="3" reversed type="a"><li value="5">ol-valid</li></ol>',
      '',
      '<ol start="x" type="z9"><li value="x">ol-invalid</li></ol>',
      '',
      '<table><tr><td colspan="2" align="center">td-valid</td><td colspan="0" align="bogus">td-invalid</td><th scope="col">th-valid</th><th scope="bad">th-invalid</th></tr></table>',
      '',
      '<table><colgroup span="2"><col></colgroup><tr><td>cg-valid</td></tr></table>',
      '',
      '<details open><summary>details-valid</summary>details-body</details>',
      '',
      '<time datetime="2026-10-16">time-valid</time> <time datetime="">time-invalid</time>',
      '',
      '<div align="center">div-valid</div>',
      '',
      '<div align="bogus">div-invalid</div>',
      '',
      '<title>',
      '',
      '## title-heading',
      '',
      '```js',
      'const titleCode = 1;',
      '```',
      '',
      '</title>',
      '',
      ':smile: emoji-line',
      '',
      '<span role="img" aria-label="author-label">author-span</span>',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await onBothSurfaces(userAPage, pageId, path, async (prose) => {
      await expect(prose.getByRole('heading', { name: 'classify corpus' })).toBeVisible();
      await expectNoFailureUi(userAPage);
      await expect(prose.locator('object, form, template, applet, plaintext, math, iframe')).toHaveCount(0);

      const text = (await prose.textContent()) ?? '';
      expect(text).toContain('<user>@<host>');
      expect(text).toContain('<thing>');
      await expect(prose.getByText('ssh-literal')).toBeVisible();
      await expect(prose.getByText('thing-literal')).toBeVisible();

      await expect(prose.locator('ol[start="3"][reversed][type="a"]')).toHaveCount(1);
      await expect(prose.locator('li[value="5"]')).toHaveCount(1);
      const invalidOl = prose.locator('ol', { hasText: 'ol-invalid' });
      await expect(invalidOl).not.toHaveAttribute('start', /.*/);
      await expect(invalidOl).not.toHaveAttribute('type', /.*/);
      await expect(invalidOl.locator('li')).not.toHaveAttribute('value', /.*/);

      await expect(prose.getByText('td-valid')).toHaveAttribute('colspan', '2');
      await expect(prose.getByText('td-invalid')).not.toHaveAttribute('colspan', /.*/);
      await expect(prose.getByText('th-valid')).toHaveAttribute('scope', 'col');
      await expect(prose.getByText('th-invalid')).not.toHaveAttribute('scope', /.*/);
      await expect(prose.locator('colgroup[span="2"]')).toHaveCount(1);
      await expect(prose.locator('details[open]')).toHaveCount(1);
      await expect(prose.getByText('time-valid')).toHaveAttribute('datetime', '2026-10-16');
      await expect(prose.getByText('time-invalid')).not.toHaveAttribute('datetime', /.*/);
      await expect(prose.getByText('div-valid')).toHaveAttribute('align', 'center');
      await expect(prose.getByText('div-invalid')).not.toHaveAttribute('align', /.*/);

      // Content between separate raw chunks of an unknown/stripped tag is preserved.
      await expect(prose.getByRole('heading', { name: 'title-heading' })).toBeVisible();
      await expect(prose.locator('pre', { hasText: 'const titleCode = 1;' })).toHaveCount(1);

      // Generated emoji labels survive; an author span never gets role/aria-label.
      await expect(prose.locator('[role="img"][aria-label]').first()).toBeAttached();
      await expect(prose.getByText('author-span')).not.toHaveAttribute('role', /.*/);
      await expect(prose.getByText('author-span')).not.toHaveAttribute('aria-label', /.*/);
    });
    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
  });

  test('anchors and source are preserved: kept author ids are fragment targets, clobbering names and generated-id collisions are dropped', async ({
    userAPage,
  }) => {
    const path = newPath('anchors');
    const body = [
      '# anchors corpus',
      '',
      '<span id="faq">faq-anchor</span>',
      '',
      '<span id="location">clobber-id</span> <a name="cookie">clobber-name</a>',
      '',
      '[to faq](#faq)',
      '',
      '<span id="dup">dup-first</span> <span id="dup">dup-second</span>',
      '',
      '[to nm](#nm)',
      '',
      ...Array.from({ length: 60 }, (_, i) => `anchor filler ${i}\n`),
      '<a name="nm">nm-anchor</a>',
      '',
      '## Setup',
      '',
      '<span id="setup">collides-with-heading</span>',
      '',
      'footnote ref[^1]',
      '',
      '[^1]: the note',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });
    await userAPage.goto(path);

    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.getByRole('heading', { name: 'anchors corpus' })).toBeVisible();
    await expect(prose.getByText('faq-anchor')).toHaveAttribute('id', 'faq');
    await expect(prose.getByText('clobber-id')).not.toHaveAttribute('id', /.+/);
    await expect(prose.getByText('clobber-name')).not.toHaveAttribute('name', /.+/);
    await expect(prose.getByText('collides-with-heading')).not.toHaveAttribute('id', /.+/);
    await expect(prose.locator('h2#setup')).toHaveCount(1);
    await expect(prose.locator('a[data-footnote-ref]')).toHaveCount(1);
    await expect(prose.locator('a[data-footnote-ref]')).not.toHaveAttribute('tabindex', /.*/);

    await expect(prose.getByText('dup-first')).toHaveAttribute('id', 'dup');
    await expect(prose.getByText('dup-second')).not.toHaveAttribute('id', /.+/);
    await expect(prose.getByText('nm-anchor')).toHaveAttribute('name', 'nm');
    await prose.getByRole('link', { name: 'to nm' }).click();
    await expect(userAPage.getByText('nm-anchor')).toBeInViewport();
    await expect(userAPage).toHaveURL(/#nm$/);

    // The kept author id is a real fragment target, also on a direct load.
    await userAPage.goto(`${path}#faq`);
    await expect(userAPage.locator('#faq')).toBeInViewport();
    await userAPage.reload();
    await expect(userAPage.locator('#faq')).toHaveCount(1);

    // A malformed percent-encoded hash must not crash the page.
    await userAPage.goto(`${path}#%E0%A4%A`);
    await expect(userAPage.locator('.crowi-prose').getByRole('heading', { name: 'anchors corpus' })).toBeVisible();

    await userAPage.goto(`${path}#Setup`);
    await expect(userAPage.locator('h2#setup')).toBeVisible();

    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
  });

  test('image-page-preview: raw img display values become the helper figure/style and author style is dropped', async ({ userAPage }) => {
    const path = newPath('image');
    const body = [
      '# image corpus',
      '',
      '<img src="/e2e-a.png" alt="raw-float" data-crowi-image-float="right" data-crowi-image-width="40%" style="border:9px solid red">',
      '',
      '<p>text <img src="/e2e-b.png" alt="raw-inline" data-crowi-image-float="right" data-crowi-image-width="50px"> more</p>',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await onBothSurfaces(userAPage, pageId, path, async (prose, surface) => {
      await expect(prose.getByRole('heading', { name: 'image corpus' })).toBeVisible();
      const floated = prose.locator('img[alt="raw-float"]');
      await expect(floated).toHaveCount(1);
      // The standalone-figure wrapper is synthesized by the API renderer, so only the page surface has it.
      if (surface === 'page') await expect(floated.locator('xpath=ancestor::figure[contains(@class,"crowi-figure")]')).toHaveCount(1);
      expect(await floated.evaluate((el) => (el as HTMLElement).style.width)).toBe('40%');
      expect(await floated.evaluate((el) => (el as HTMLElement).style.border)).toBe('');
      await expect(floated).not.toHaveAttribute('data-crowi-image-float', /.*/);

      const inline = prose.locator('img[alt="raw-inline"]');
      await expect(inline).toHaveCount(1);
      await expect(inline.locator('xpath=ancestor::figure')).toHaveCount(0);
    });
  });

  test('image-page-preview: a raw attachment img keeps its display width, drops author style and opens the attachment detail on click', async ({
    userAPage,
  }) => {
    const holderId = await createPageViaApi(userAPage.context(), { path: newPath('image-holder'), body: '# attachment holder\n' });
    const { url } = await uploadAttachmentViaApi(userAPage.context(), { pageId: holderId, fileName: 'e2e-pixel.png', contentType: 'image/png', data: PNG_1X1 });
    const path = newPath('image-attachment');
    const body = ['# attachment corpus', '', `<img src="${url}" alt="raw-attachment" data-crowi-image-width="40%" style="border:9px solid red">`, ''].join(
      '\n',
    );
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await onBothSurfaces(userAPage, pageId, path, async (prose) => {
      const attachment = prose.locator('img[alt="raw-attachment"]');
      await expect(attachment).toHaveCount(1);
      expect(await attachment.evaluate((el) => (el as HTMLElement).style.width)).toBe('40%');
      expect(await attachment.evaluate((el) => (el as HTMLElement).style.border)).toBe('');
      await expect(attachment).not.toHaveAttribute('data-crowi-image-width', /.*/);
    });

    await userAPage.goto(path);
    await userAPage.locator('.crowi-prose').first().locator('img[alt="raw-attachment"]').click();
    const downloadLink = userAPage.getByRole('link', { name: /^(Download|ダウンロード)$/ });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute('href', `${url}/original`);
  });

  test('source-unchanged: stale recompute and history viewing never change the saved body', async ({ userAPage }) => {
    const path = newPath('source');
    const body = [
      '# source corpus',
      '',
      `<div class="evil" style="color:red" onclick="${FIRE}">source-target</div>`,
      '',
      '```js',
      'const sourceCode = 1;',
      '```',
      '',
    ].join('\n');
    const pageId = await createPageViaApi(userAPage.context(), { path, body });

    await forceStaleRendererVersion(pageId);
    await userAPage.goto(path);
    const prose = userAPage.locator('.crowi-prose').first();
    await expect(prose.getByText('source-target')).not.toHaveAttribute('class', /evil/);
    await expect(prose.locator('pre')).toContainText('const sourceCode = 1;');
    // Shiki output keeps its generated colors after the strict pass.
    await expect(prose.locator('pre.shiki span[style*="--shiki-light"]').first()).toBeAttached();
    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);

    // The preview renders the same body through the strict boundary without writing it back.
    await new EditorPage(userAPage).openSharedPage(pageId);
    await expect(userAPage.locator('.crowi-prose').first().getByText('source-target')).not.toHaveAttribute('class', /evil/);
    expect(await getPageBody(userAPage.context(), pageId)).toBe(body);
    expect(await firedCount(userAPage)).toBe(0);

    const next = `${body}\nsecond revision\n`;
    await updatePageViaApi(userAPage.context(), { pageId, body: next });
    await userAPage.goto(path);
    await expect(userAPage.locator('.crowi-prose').first().getByText('second revision')).toBeVisible();
    expect(await getPageBody(userAPage.context(), pageId)).toBe(next);
  });
});
