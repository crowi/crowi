import type { BrowserContext, Page } from '@playwright/test';
import { accessTokenFromContext, createPageViaApi, getPageBody, getPageLatestRevisionId, getPageRenderedAst } from '../src/api';
import { E2E_API_URL, E2E_WEB_URL, storageStatePath } from '../src/config';
import { expect, test } from '../src/fixtures';
import { EditorPage } from '../src/pages/editor-page';

/**
 * feature-html-sanitizer-toggle Phase 3 — admin switch for the HTML
 * sanitization policy, exercised against the real API, the real Next proxy
 * and a real browser. The suite mutates the instance-wide Security setting, so
 * it is serial and restores the setting in `afterAll`; never run it in the
 * same invocation as another suite that edits Security settings.
 */

const EMBED_ORIGIN = 'https://e2e-embed.example';
const REDIRECT_ORIGIN = 'https://e2e-redirect.example';

type SecuritySettings = { registrationMode: string; registrationWhiteList: string[]; linkCardEnabled: boolean; htmlSanitizationEnabled: boolean };

async function readSecurity(context: BrowserContext): Promise<SecuritySettings> {
  const token = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/security`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET security failed: HTTP ${response.status}`);
  return (await response.json()) as SecuritySettings;
}

async function setHtmlSanitization(context: BrowserContext, enabled: boolean): Promise<void> {
  const token = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/security`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ htmlSanitizationEnabled: enabled }),
  });
  if (!response.ok) throw new Error(`PUT security failed: HTTP ${response.status} ${await response.text()}`);
}

/** Serve a fixed external HTTPS embed so the suite never depends on the network. */
async function stubEmbed(page: Page): Promise<{ submitted: string[] }> {
  const submitted: string[] = [];
  await page.route(`${EMBED_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/submitted')) {
      submitted.push(url);
      await route.fulfill({ status: 200, contentType: 'text/html', body: 'submitted' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><body><p id="embed-root">pending</p><form action="/submitted" method="post"><input name="a"></form><script>document.getElementById("embed-root").textContent="script-ran";try{document.forms[0].submit()}catch(e){}</script></body>',
    });
  });
  return { submitted };
}

function newPath(label: string): string {
  return `/e2e/html-sanitizer-toggle/${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const BODY = [
  '# toggle corpus',
  '',
  '<div class="e2e-box" style="color:red;background-image:url(https://e2e-forbidden.invalid/bg.png)">styled-box</div>',
  '',
  `<iframe src="${EMBED_ORIGIN}/embed" srcdoc="<b>x</b>" sandbox="allow-top-navigation" title="e2e embed"></iframe>`,
  '',
  `<iframe src="${E2E_WEB_URL}/admin/security"></iframe>`,
  '',
  `<iframe src="${E2E_API_URL}/api/app/info"></iframe>`,
  '',
  '<iframe src="http://e2e-embed.example/plain"></iframe>',
  '',
  'tail-text',
  '',
].join('\n');

test.describe.configure({ mode: 'serial' });

test.describe('html sanitizer toggle', () => {
  let original: SecuritySettings | undefined;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath.admin });
    original = await readSecurity(context);
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!original) return;
    const context = await browser.newContext({ storageState: storageStatePath.admin });
    await setHtmlSanitization(context, original.htmlSanitizationEnabled);
    await context.close();
  });

  test('toggle-roundtrip: page and preview follow the setting on reopen, the body never changes', async ({ adminPage, userAPage }) => {
    test.setTimeout(180_000);
    await setHtmlSanitization(adminPage.context(), true);

    const path = newPath('roundtrip');
    const pageId = await createPageViaApi(userAPage.context(), { path, body: BODY });
    const revisionBefore = await getPageLatestRevisionId(userAPage.context(), pageId);
    const astBefore = JSON.stringify(await getPageRenderedAst(userAPage.context(), pageId));
    await stubEmbed(userAPage);

    const prose = () => userAPage.locator('.crowi-prose').first();

    await test.step('default ON: nothing relaxed is rendered', async () => {
      await userAPage.goto(path);
      await expect(userAPage.getByText('styled-box')).toBeVisible();
      await expect(prose().locator('iframe')).toHaveCount(0);
      await expect(userAPage.getByText('styled-box')).not.toHaveAttribute('style', /.+/);
    });

    await test.step('OFF: an already open view stays strict, a reopened one relaxes', async () => {
      await setHtmlSanitization(adminPage.context(), false);
      await expect(prose().locator('iframe')).toHaveCount(0);

      await userAPage.reload();
      const box = userAPage.getByText('styled-box');
      await expect(box).toHaveAttribute('class', /e2e-box/);
      await expect(box).toHaveAttribute('style', /color:\s*red/);
      expect(await box.getAttribute('style')).not.toContain('background');

      const frames = prose().locator('iframe');
      await expect(frames).toHaveCount(1);
      const frame = frames.first();
      await expect(frame).toHaveAttribute('src', `${EMBED_ORIGIN}/embed`);
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation');
      await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      await expect(frame).toHaveAttribute('loading', 'lazy');
      await expect(frame).not.toHaveAttribute('srcdoc', /.*/);
      await expect(frame).not.toHaveAttribute('allow', /.*/);
      await expect(userAPage.frameLocator('.crowi-prose iframe').locator('#embed-root')).toHaveText('script-ran');
      await expect(userAPage.getByText('tail-text')).toBeVisible();
    });

    await test.step('preview applies the same policy', async () => {
      const editor = new EditorPage(userAPage);
      await editor.openSharedPage(pageId);
      const previewProse = userAPage.locator('.crowi-prose').first();
      await expect(previewProse).toBeVisible({ timeout: 30_000 });
      await expect(previewProse.locator('iframe')).toHaveCount(1, { timeout: 30_000 });
    });

    await test.step('ON again, then OFF again, without re-saving the body', async () => {
      await setHtmlSanitization(adminPage.context(), true);
      await userAPage.goto(path);
      await expect(userAPage.getByText('styled-box')).toBeVisible();
      await expect(prose().locator('iframe')).toHaveCount(0);

      await setHtmlSanitization(adminPage.context(), false);
      await userAPage.goto(path);
      await expect(prose().locator('iframe')).toHaveCount(1);
    });

    await test.step('a failed public app-info fetch falls back to strict even while OFF', async () => {
      await userAPage.route('**/api/app/info', (route) => route.abort());
      await userAPage.goto(path);
      await expect(userAPage.getByText('styled-box')).toBeVisible();
      await expect(prose().locator('iframe')).toHaveCount(0);
      await expect(userAPage.getByText('styled-box')).not.toHaveAttribute('style', /.+/);
      await userAPage.unroute('**/api/app/info');
    });

    await test.step('the stored body, revision and rendered AST are untouched', async () => {
      expect(await getPageBody(userAPage.context(), pageId)).toBe(BODY);
      expect(await getPageLatestRevisionId(userAPage.context(), pageId)).toBe(revisionBefore);
      expect(JSON.stringify(await getPageRenderedAst(userAPage.context(), pageId))).toBe(astBefore);
    });
  });

  test('web-frame-response: framing denial headers by entry path', async ({ adminPage }) => {
    const get = (pathname: string) => fetch(`${E2E_WEB_URL}${pathname}`, { redirect: 'manual' });

    await test.step('ordinary pages carry both headers', async () => {
      for (const pathname of ['/login', '/admin/security', '/e2e/does-not-exist']) {
        const response = await get(pathname);
        expect(response.headers.get('content-security-policy'), pathname).toContain("frame-ancestors 'none'");
        expect(response.headers.get('x-frame-options'), pathname).toBe('DENY');
      }
    });

    await test.step('case variants of the relay entrance are not excluded', async () => {
      for (const pathname of ['/_ARTIFACT-FRAME', '/_Artifact-Frame/']) {
        const response = await get(pathname);
        expect(response.headers.get('content-security-policy'), pathname).toContain("frame-ancestors 'none'");
        expect(response.headers.get('x-frame-options'), pathname).toBe('DENY');
      }
    });

    // Next matches rewrites case-insensitively, so `/API` and `/Api/x` are proxied to the api
    // and Next does not carry proxy-set headers onto that proxied response. They never render
    // an app page, so there is nothing to frame; assert only that they are not a wiki page.
    await test.step('case variants of /api are forwarded to the api, not rendered as app pages', async () => {
      for (const pathname of ['/API', '/Api/x']) {
        const response = await get(pathname);
        expect(response.headers.get('content-type') ?? '', pathname).not.toContain('text/html');
      }
    });

    await test.step('API and the relay entrances are excluded', async () => {
      for (const pathname of ['/api', '/api/x', '/_artifact-frame', '/_artifact-frame/']) {
        const response = await get(pathname);
        expect(response.headers.get('content-security-policy') ?? '', pathname).not.toContain("frame-ancestors 'none'");
        expect(response.headers.get('x-frame-options'), pathname).toBeNull();
      }
    });

    await test.step('the relay document keeps its own CSP and gets no DENY', async () => {
      const response = await get(`/_artifact-frame?src=${encodeURIComponent(`${E2E_WEB_URL}/x`)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      expect(response.headers.get('x-frame-options')).toBeNull();
    });

    await test.step('an allowed external src redirecting into the admin UI is refused by the final response', async () => {
      test.setTimeout(120_000);
      await setHtmlSanitization(adminPage.context(), false);
      const path = newPath('redirect');
      await createPageViaApi(adminPage.context(), { path, body: `<iframe src="${REDIRECT_ORIGIN}/go"></iframe>\n\nafter-frame\n` });

      await adminPage.route(`${REDIRECT_ORIGIN}/**`, (route) => route.fulfill({ status: 302, headers: { location: `${E2E_WEB_URL}/admin/security` } }));
      const finalHeaders: Array<Record<string, string>> = [];
      adminPage.on('response', (response) => {
        if (response.url() === `${E2E_WEB_URL}/admin/security` && response.frame() !== adminPage.mainFrame()) {
          finalHeaders.push(response.headers());
        }
      });

      await adminPage.goto(path);
      await expect(adminPage.getByText('after-frame')).toBeVisible();
      await expect(adminPage.locator('.crowi-prose iframe')).toHaveCount(1);
      await expect.poll(() => finalHeaders.length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(finalHeaders[0]?.['x-frame-options']).toBe('DENY');
      expect(finalHeaders[0]?.['content-security-policy']).toContain("frame-ancestors 'none'");
      await expect(adminPage.frameLocator('.crowi-prose iframe').getByRole('heading')).toHaveCount(0);
    });
  });
});
