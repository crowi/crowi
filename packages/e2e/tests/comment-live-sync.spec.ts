import { addCommentViaApi, createPageViaApi, deleteCommentViaApi, getPageLatestRevisionId } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-live-page-comment-sync — a comment posted / deleted by another
 * user surfaces on a viewer's page without a reload, riding the same
 * `/presence` channel as the viewer list + page-updated soft-refresh.
 *
 * Two authenticated contexts view a freshly-created page (isolated from
 * the collab shared page). Once userA's presence row shows userB, both
 * WebSockets are connected — so the comment-changed fan-out can never be
 * missed by a connection race. userB then posts / deletes via the API
 * and userA's list must live-append / live-remove the comment.
 *
 * Only single-instance (local emit) fan-out is exercised here; the
 * cross-instance Redis leg is covered by the presence-service unit tests.
 * The append / removal steps assert the AC#1 / AC#2 1s liveness budget
 * (measured from the API mutation returning to the change surfacing on
 * the viewer page) and the append step also asserts the transient
 * new-comment highlight (AC#1), whose seen-set diff is additionally
 * unit-tested in `comment-highlight.test.ts`.
 */

/**
 * AC#1 / AC#2 liveness budget: a change made by another user must surface
 * on the viewer page within 1s. Measured from the moment the triggering
 * API mutation returns (the server has already emitted the event by then)
 * to the moment the DOM reflects it. The underlying Playwright wait keeps
 * a generous safety timeout so a slow-but-correct run fails with a clear
 * "took Nms" budget assertion rather than a bare locator timeout.
 */
const LIVE_SYNC_BUDGET_MS = 1_000;
const LIVE_SYNC_SAFETY_MS = 10_000;

test('a comment posted by another user live-appends (with highlight) and live-removes on a viewer page', async ({ userAPage, userBPage }) => {
  // Dedicated page so this never collides with the collab spec's shared page.
  const pagePath = `/e2e/comment-live/${Date.now()}`;
  const pageId = await createPageViaApi(userAPage.context(), {
    path: pagePath,
    body: '# Comment live sync\n\nSeeded by comment-live-sync.spec.\n',
  });
  const revisionId = await getPageLatestRevisionId(userAPage.context(), pageId);

  // Both users open the page in view mode (not the editor).
  await Promise.all([userAPage.goto(pagePath), userBPage.goto(pagePath)]);

  // userA's presence row shows userB once both presence sockets are up —
  // the connected signal that removes the post-before-connect race.
  await expect(userAPage.getByTestId('live-presence-row').first().getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

  const marker = `E2E live comment ${Date.now()}`;
  const newComment = userAPage.locator('.comment-item', { hasText: marker });
  let commentId = '';

  await test.step('live-append within budget + transient highlight (AC#1)', async () => {
    // userB posts a comment via the API. Start the liveness clock the
    // instant the mutation returns — the server has already emitted the
    // comment-changed signal at that point.
    commentId = await addCommentViaApi(userBPage.context(), { pageId, revisionId, comment: marker });
    const startedAt = Date.now();

    await expect(newComment).toBeVisible({ timeout: LIVE_SYNC_SAFETY_MS });
    const appendMs = Date.now() - startedAt;
    expect(appendMs, `live append took ${appendMs}ms (budget ${LIVE_SYNC_BUDGET_MS}ms)`).toBeLessThan(LIVE_SYNC_BUDGET_MS);

    // AC#1 — the freshly-appended comment carries the transient amber
    // highlight (`.comment-item.is-new`). It fades after a few seconds,
    // but the class is applied the same tick the comment appears, so it
    // is present here well within its window.
    await expect(newComment).toHaveClass(/\bis-new\b/, { timeout: LIVE_SYNC_BUDGET_MS });
  });

  await test.step('live-remove within budget (AC#2)', async () => {
    // userB deletes it. userA's list must drop it live, within budget.
    await deleteCommentViaApi(userBPage.context(), { pageId, commentId });
    const startedAt = Date.now();

    await expect(userAPage.getByText(marker)).toHaveCount(0, { timeout: LIVE_SYNC_SAFETY_MS });
    const removeMs = Date.now() - startedAt;
    expect(removeMs, `live removal took ${removeMs}ms (budget ${LIVE_SYNC_BUDGET_MS}ms)`).toBeLessThan(LIVE_SYNC_BUDGET_MS);
  });
});
