import type { BrowserContext, Page } from '@playwright/test';
import { accessTokenFromContext, createPageViaApi } from '../src/api';
import { E2E_API_URL, storageStatePath } from '../src/config';
import { expect, test } from '../src/fixtures';
import { EditorPage } from '../src/pages/editor-page';

/**
 * artifact-edit-guard — an artifact page's body is never offered to the
 * Markdown editor. Direct `/_edit` URLs (by id and by path) show the notice
 * instead of the editor, and the browser starts no collab token request and
 * no collab websocket for them, while a Markdown page still connects.
 *
 * The artifact is created through the API with the artifact header, which
 * needs artifact delivery configured; the admin settings are switched to
 * same-origin for the test and restored afterwards. The body is a
 * self-contained document (the API package is not imported at runtime).
 */
const ARTIFACT_HTML = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  '<style>body { color: rebeccapurple; }</style>',
  '</head>',
  '<body>',
  '<p>hello from the edit guard e2e</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

const NOTICE_JA = 'この編集画面では artifact を編集できません。本文の編集には CLI または MCP を使用してください。';
const NOTICE_EN = 'This editor cannot edit artifact pages. Use the CLI or MCP to edit the body.';

interface ArtifactSettings {
  sameOriginEnabled: boolean;
  allowWebFonts: boolean;
  maxBytes: number;
}

async function adminArtifactSettings(context: BrowserContext, method: 'GET' | 'PUT', settings?: ArtifactSettings): Promise<ArtifactSettings> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/artifact`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    ...(settings ? { body: JSON.stringify(settings) } : {}),
  });
  if (!response.ok) throw new Error(`/api/admin/artifact ${method} failed: HTTP ${response.status} ${await response.text()}`);
  return ((await response.json()) as { settings: ArtifactSettings }).settings;
}

async function createArtifactPageViaApi(context: BrowserContext, path: string): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'X-Crowi-Page-Content-Type': 'artifact' },
    body: JSON.stringify({ path, body: ARTIFACT_HTML }),
  });
  if (!response.ok) throw new Error(`Failed to create artifact page ${path}: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { page?: { _id?: string } };
  if (!body.page?._id) throw new Error(`No page id in response: ${JSON.stringify(body)}`);
  return body.page._id;
}

/** Records collab traffic from before the first navigation: token requests and `/collab` websockets. */
function watchCollabTraffic(page: Page) {
  const tokenRequests: string[] = [];
  const sockets: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/yjs-token')) tokenRequests.push(request.url());
  });
  page.on('websocket', (socket) => {
    if (socket.url().includes('/collab')) sockets.push(socket.url());
  });
  return { tokenRequests, sockets };
}

test.describe('artifact edit guard', () => {
  let original: ArtifactSettings | null = null;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath.admin });
    try {
      original = await adminArtifactSettings(context, 'GET');
      await adminArtifactSettings(context, 'PUT', { ...original, sameOriginEnabled: true });
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!original) return;
    const context = await browser.newContext({ storageState: storageStatePath.admin });
    try {
      await adminArtifactSettings(context, 'PUT', original);
    } finally {
      await context.close();
    }
  });

  test('a direct /_edit URL of an artifact page shows the notice (by id and by path) and starts no collab traffic', async ({ userAPage }) => {
    const path = `/e2e/artifact-edit-guard/artifact-${Date.now()}`;
    const pageId = await createArtifactPageViaApi(userAPage.context(), path);
    const traffic = watchCollabTraffic(userAPage);

    for (const url of [`/_edit?page_id=${encodeURIComponent(pageId)}`, `/_edit?path=${encodeURIComponent(path)}`]) {
      await userAPage.goto(url);
      await expect(userAPage.getByText(new RegExp(`${NOTICE_JA}|${NOTICE_EN}`))).toBeVisible();
      await expect(userAPage.locator('.cm-content')).toHaveCount(0);
    }

    // Give a mistakenly-started session time to show up before asserting its absence.
    await userAPage.waitForTimeout(1_500);
    expect(traffic.tokenRequests).toEqual([]);
    expect(traffic.sockets).toEqual([]);

    // The way back leads to the page itself.
    await userAPage.getByRole('link', { name: /ページに戻る|Back to page/ }).click();
    await expect(userAPage).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`));
  });

  test('the artifact page view offers no edit button', async ({ userAPage }) => {
    const path = `/e2e/artifact-edit-guard/view-${Date.now()}`;
    await createArtifactPageViaApi(userAPage.context(), path);
    await userAPage.goto(path);
    await expect(userAPage.getByText('hello from the edit guard e2e').or(userAPage.locator('iframe')).first()).toBeAttached({ timeout: 30_000 });
    await expect(userAPage.getByRole('button', { name: /^(編集|Edit)$/ })).toHaveCount(0);
  });

  test('a Markdown page still opens the editor and connects to collab', async ({ userAPage }) => {
    const path = `/e2e/artifact-edit-guard/markdown-${Date.now()}`;
    const pageId = await createPageViaApi(userAPage.context(), { path, body: '# markdown stays editable' });
    const traffic = watchCollabTraffic(userAPage);

    const editor = new EditorPage(userAPage);
    await editor.openSharedPage(pageId);

    expect(traffic.tokenRequests.length).toBeGreaterThan(0);
    expect(traffic.sockets.length).toBeGreaterThan(0);
    await expect(userAPage.getByText(new RegExp(`${NOTICE_JA}|${NOTICE_EN}`))).toHaveCount(0);
  });
});
