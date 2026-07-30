import type { Response } from '@playwright/test';
import { createPagesViaApi, inviteUsersViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-unified-pager — the 3 previously-independent pagination
 * implementations (offset prev/next `pagination.tsx`, client-computed
 * numbered `search-pager.tsx`, server-computed numbered `users-table.tsx`'s
 * `UsersPager`) were collapsed into a single `<Pager>` primitive
 * (`components/ui/pager.tsx`). That refactor touches 3 real navigation
 * flows with no prior e2e coverage, so this spec exercises the 2 modes end
 * to end: numbered (search results + admin users list) and prev-next (the
 * main page list). Every test seeds just enough entries via the API to push
 * the list past its first page, so the assertions cover a *real* 2nd-page
 * fetch — not just a component in isolation.
 */

/** English + Japanese "Previous"/"Next" — the spec keeps these as literal Paraglide keys, so match both locales. */
const PREVIOUS_PATTERN = /^(Previous|前へ)$/;
const NEXT_PATTERN = /^(Next|次へ)$/;

/** `common.pager.page_label` renders "Page {page}" (en) / "{page} ページ目" (ja). */
function pageLabelPattern(page: number): RegExp {
  return new RegExp(`^(Page ${page}|${page} ページ目)$`);
}

test('search results pagination (numbered mode): page-number and Prev/Next clicks fetch the correct page', async ({ userAPage }) => {
  test.setTimeout(90_000);

  // RESULTS_PER_PAGE is 50 (packages/web/src/app/(auth)/_search/page.tsx) —
  // seed 105 matching pages so we can test page 1 → 2 → 3 transitions.
  const token = `e2epagersearch${Date.now()}`;
  await createPagesViaApi(
    userAPage.context(),
    Array.from({ length: 105 }, (_, i) => ({
      path: `/e2e/pagination/search/${token}/${i}`,
      body: `# Pager search probe ${i}\n\nSeeded by pagination.spec (${token}).\n`,
    })),
  );

  await test.step('landing on the results shows page 1 as the active numbered button', async () => {
    await userAPage.goto(`/_search?q=${token}`);
    await expect(userAPage.getByRole('navigation')).toBeVisible();
    await expect(userAPage.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  await test.step('clicking page "3" (skipping 2) issues a page=3 request and marks it active', async () => {
    const responsePromise = userAPage.waitForResponse(
      (res: Response) => res.url().includes('/api/search') && res.url().includes('page=3') && res.request().method() === 'GET',
    );
    await userAPage.getByRole('button', { name: '3', exact: true }).click();
    await responsePromise;
    await expect(userAPage.getByRole('button', { name: '3', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  await test.step('clicking Previous (page 2) issues a page=2 request and marks it active', async () => {
    // Page 2 has not been fetched yet (we jumped from page 1 to page 3), so this
    // request is guaranteed to fire and will not be served from cache.
    const responsePromise = userAPage.waitForResponse(
      (res: Response) => res.url().includes('/api/search') && res.url().includes('page=2') && res.request().method() === 'GET',
    );
    await userAPage.getByRole('button', { name: PREVIOUS_PATTERN }).click();
    await responsePromise;
    await expect(userAPage.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  await test.step('clicking Next (page 3) returns to page 3', async () => {
    // No waitForResponse here: page 3 was already fetched earlier and react-query's
    // 60s default staleTime (providers.tsx) serves it straight from cache, so no
    // new request is guaranteed to fire — assert the resulting UI state instead.
    await userAPage.getByRole('button', { name: NEXT_PATTERN }).click();
    await expect(userAPage.getByRole('button', { name: '3', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test('admin users list pagination (numbered mode): clicking a page number fetches the next page', async ({ adminPage }) => {
  test.setTimeout(90_000);

  // Admin users list default limit is 50 (ListAdminUsersRequestSchema) —
  // invite 55 users (no email send) so the 2nd page is real.
  const token = `e2epageradmin${Date.now()}`;
  await inviteUsersViaApi(
    adminPage.context(),
    Array.from({ length: 55 }, (_, i) => `e2e-pager-user-${token}-${i}@dev.crowi.wiki`),
  );

  await test.step('the users list shows page 1 as active', async () => {
    await adminPage.goto('/admin/users');
    await expect(adminPage.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  await test.step('clicking page "2" issues a page=2 request and marks it active', async () => {
    const responsePromise = adminPage.waitForResponse(
      (res: Response) => res.url().includes('/api/admin/users') && res.url().includes('page=2') && res.request().method() === 'GET',
    );
    await adminPage.getByRole('button', { name: '2', exact: true }).click();
    await responsePromise;
    await expect(adminPage.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test('main page list pagination (prev-next mode): clicking Next/Previous updates the offset and fetches the correct page', async ({ userAPage }) => {
  test.setTimeout(120_000);

  // The portal listing's default limit is 100 (DEFAULT_PAGE_LIMIT in
  // page-list.tsx) — seed 101 children so `pager.next` is non-null on page 1.
  const token = `e2epagerlist${Date.now()}`;
  const portalPath = `/e2e/pagination/pagelist/${token}`;
  await createPagesViaApi(
    userAPage.context(),
    Array.from({ length: 101 }, (_, i) => ({
      path: `${portalPath}/${i}`,
      body: `# Pager page-list probe ${i}\n\nSeeded by pagination.spec (${token}).\n`,
    })),
  );

  await test.step('the portal listing shows "Page 1" with Previous disabled and Next enabled', async () => {
    await userAPage.goto(`${portalPath}/`);
    await expect(userAPage.getByText(pageLabelPattern(1))).toBeVisible();
    await expect(userAPage.getByRole('button', { name: PREVIOUS_PATTERN })).toBeDisabled();
    await expect(userAPage.getByRole('button', { name: NEXT_PATTERN })).toBeEnabled();
  });

  await test.step('clicking Next issues an offset=100 request and shows "Page 2"', async () => {
    const responsePromise = userAPage.waitForResponse(
      (res: Response) => res.url().includes('/api/pages/list') && res.url().includes('offset=100') && res.request().method() === 'GET',
    );
    await userAPage.getByRole('button', { name: NEXT_PATTERN }).click();
    await responsePromise;
    await expect(userAPage.getByText(pageLabelPattern(2))).toBeVisible();
    await expect(userAPage.getByRole('button', { name: NEXT_PATTERN })).toBeDisabled();
  });

  await test.step('clicking Previous returns to "Page 1"', async () => {
    // No waitForResponse here: offset=0 was already fetched above and react-query's
    // 60s default staleTime (providers.tsx) serves it straight from cache, so no
    // new request is guaranteed to fire — assert the resulting UI state instead.
    await userAPage.getByRole('button', { name: PREVIOUS_PATTERN }).click();
    await expect(userAPage.getByText(pageLabelPattern(1))).toBeVisible();
  });
});
