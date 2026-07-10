import type { Page, Response } from '@playwright/test';
import { createPageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-search-result-grant-refilter (SEC-SEARCH-DELEGATED) — `GET
 * /search` (and the `/_search` UI it backs) must only surface pages the
 * requesting user is authorized to read.
 *
 * The API-boundary defense-in-depth itself (re-filtering hits a
 * driver-that-forgot-to-check-grant returns) is unit/integration-tested
 * against a mock driver in `packages/api/src/hono/handlers/search.test.ts`
 * and `packages/api/src/models/page.test.ts::findListByPageIds`. This spec
 * instead exercises the real `mongo` search driver end-to-end through the
 * `/_search` UI, proving the user-visible contract: an owner-grant page
 * created by one user does not leak into another user's search results —
 * neither in the API response nor in the rendered result list — while it
 * still surfaces in the creator's own results.
 */

/** Navigate to `/_search?q=<token>` and return the parsed `GET /search` response body. */
async function searchAndReadResponse(page: Page, token: string): Promise<{ meta: { results: number }; data: Array<{ pageId: string }> }> {
  const responsePromise = page.waitForResponse((res: Response) => res.url().includes('/api/v2/search') && res.request().method() === 'GET');
  await page.goto(`/_search?q=${token}`);
  const response = await responsePromise;
  return response.json();
}

test('search results respect page grant: an owner-only page is visible to its creator but hidden from another user', async ({ userAPage, userBPage }) => {
  // Unique per-run token: doubles as the page path segment and the search
  // keyword, so the path-match pass in the search driver reliably matches
  // exactly this page and nothing left over from a previous run.
  const token = `e2egrantsearch${Date.now()}`;
  const pagePath = `/e2e/search-grant-filter/${token}`;

  // grant 4 = GRANT_OWNER — only userA (the creator, in grantedUsers) can read it.
  const pageId = await createPageViaApi(userAPage.context(), {
    path: pagePath,
    body: `# Grant filter probe\n\nSeeded by search-grant-filter.spec (${token}).\n`,
    grant: 4,
  });

  await test.step('creator (userA) sees the page in both the API response and the result list', async () => {
    const body = await searchAndReadResponse(userAPage, token);
    expect(body.data.map((hit) => hit.pageId)).toContain(pageId);
    await expect(userAPage.getByRole('link', { name: pagePath })).toBeVisible();
  });

  await test.step('another authenticated user (userB) sees it in neither the API response nor the result list', async () => {
    const body = await searchAndReadResponse(userBPage, token);
    // AC: data[] excludes pages the viewer has no grant for, and
    // meta.results stays consistent with the (already-filtered) data.length.
    expect(body.data.map((hit) => hit.pageId)).not.toContain(pageId);
    expect(body.meta.results).toBe(body.data.length);
    await expect(userBPage.getByRole('link', { name: pagePath })).toHaveCount(0);
  });
});
