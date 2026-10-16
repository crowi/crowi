import type { Request } from '@playwright/test';
import { createPageViaApi } from '../src/api';
import { E2E_WEB_PROD } from '../src/config';
import { expect, test } from '../src/fixtures';

/**
 * Next.js prefetches a `<Link>` when it scrolls into view and should then stop.
 * Links into the reserved `/_*` routes (the `%5F…` route folders — the
 * "updated N ago" link to `/_history` in a portal or page header among them)
 * used to be prefetched hundreds of times a second for as long as the page
 * stayed open. Prefetching only happens in a production build, so this runs
 * under `e2e:prod` alone.
 */
test.skip(!E2E_WEB_PROD, 'Link prefetching only runs in a production build (pnpm --filter @crowi/e2e e2e:prod)');

/** How long the page sits idle while prefetches are counted. */
const OBSERVE_MS = 5_000;

/**
 * A prefetch of a URL with a search string fetches the route tree with and
 * without it plus the segment data, so a settled prefetch is a handful of
 * requests — not one.
 */
const MAX_SETTLED_PREFETCHES = 5;

test('a link into a reserved /_* route stops prefetching once the page settles', async ({ userAPage }) => {
  const portalPath = `/e2e/history-prefetch/${Date.now()}/`;
  await createPageViaApi(userAPage.context(), { path: portalPath, body: '# History prefetch probe\n' });

  const historyPrefetches: string[] = [];
  userAPage.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === '/_history' && url.searchParams.has('_rsc')) historyPrefetches.push(request.url());
  });

  await userAPage.goto(portalPath);
  const historyLink = userAPage.locator(`a[href="/_history?path=${encodeURIComponent(portalPath)}"]`);
  await expect(historyLink).toBeVisible();

  await userAPage.waitForTimeout(OBSERVE_MS);
  const settled = historyPrefetches.length;
  await userAPage.waitForTimeout(OBSERVE_MS);

  expect(settled, 'no prefetch was observed — is the web app a production build?').toBeGreaterThan(0);
  expect(historyPrefetches.length, 'prefetches kept firing after the page settled').toBe(settled);
  expect(historyPrefetches.length).toBeLessThanOrEqual(MAX_SETTLED_PREFETCHES);
});
