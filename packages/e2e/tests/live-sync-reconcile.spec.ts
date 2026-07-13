import type { Page, WebSocketRoute } from '@playwright/test';
import { createPageViaApi, updatePageViaApi } from '../src/api';
import { expect, test } from '../src/fixtures';

/**
 * feature-live-page-sync-reconcile — a viewer's tab going hidden then
 * visible again reconciles against the server's current head, picking up
 * a save made by another user while the tab was backgrounded.
 *
 * This is the literal user-reported symptom the spec exists to fix:
 * feature-live-page-content-sync's `page-updated` push only reaches a
 * *connected* presence socket, and the presence token query (and so the
 * socket) stops refreshing while the tab is hidden — a push made during
 * that window is lost forever without this reconcile. None of the
 * existing e2e specs (`auth-state.spec.ts` = auth, `collab.spec.ts` =
 * editor Yjs sync, `comment-live-sync.spec.ts` = comment push) cover a
 * viewing-only tab going hidden then visible, so this is the one
 * dedicated e2e case for that path — the other branches (4403 / 403 /
 * 404 / redirect / tie-break / grant-only merge / fences) are exercised
 * by `page-view-reconcile.test.tsx` (vitest/jsdom), which can control
 * timing precisely in a way an e2e spec cannot.
 *
 * Overriding `document.visibilityState` alone would NOT prove this test
 * exercises the reconcile head-GET rather than the pre-existing
 * feature-live-page-content-sync push: the fake property has no effect
 * on the real (still fully connected) presence WebSocket, so a
 * `page-updated` push frame could reach userA's tab and swap the body
 * regardless of whether reconcile exists at all. To make the reconcile
 * path the ONLY possible explanation, `routePresenceWebSocket` below
 * uses Playwright's `page.routeWebSocket()` to actually sever userA's
 * presence socket (refusing every (re)connection attempt, exactly like a
 * real network drop / laptop sleep) for the whole hidden window and
 * through the visibility recovery — the push channel is provably down
 * the entire time the update lands and the tab comes back, so the only
 * way the update can still appear is the reconcile mechanism's plain
 * (non-WebSocket) head-GET.
 */
async function routePresenceWebSocket(page: Page): Promise<{ sever: () => void; restore: () => void }> {
  let severed = false;
  let current: WebSocketRoute | null = null;

  await page.routeWebSocket(/\/presence\//, (ws) => {
    current = ws;
    if (severed) {
      // Refuse the connection outright — indistinguishable, from the
      // client's perspective, from a network drop before any handshake
      // frame arrives.
      ws.close();
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });

  return {
    sever: () => {
      severed = true;
      current?.close();
    },
    restore: () => {
      severed = false;
    },
  };
}

async function setVisibility(target: Page, state: 'visible' | 'hidden') {
  await target.evaluate((nextState) => {
    Object.defineProperty(document, 'visibilityState', { value: nextState, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('a tab going hidden -> visible reconciles a save made by another user while its presence socket is severed (no reload, no push)', async ({
  userAPage,
  userBPage,
}) => {
  const presenceSocket = await routePresenceWebSocket(userAPage);

  const pagePath = `/e2e/live-sync-reconcile/${Date.now()}`;
  const seedMarker = `Reconcile seed ${Date.now()}`;
  const pageId = await createPageViaApi(userAPage.context(), { path: pagePath, body: `# ${seedMarker}\n` });

  await userAPage.goto(pagePath);
  // Anchor on the seeded content so the initial mount-time fetch (and its
  // own reconcile epoch, over the still-healthy presence socket) has
  // already settled before the socket is severed — isolating this test to
  // the tab-revisit trigger specifically.
  await expect(userAPage.getByRole('heading', { name: seedMarker })).toBeVisible({ timeout: 30_000 });

  // Sever the presence WebSocket BEFORE going hidden and BEFORE userB's
  // save — every (re)connection attempt from here on is refused, so no
  // `page-updated` push frame can reach this tab by any path.
  presenceSocket.sever();
  await setVisibility(userAPage, 'hidden');

  // userB saves while userA's tab is hidden AND its presence socket is
  // severed — exactly the update a connected-socket-only push could never
  // guarantee delivery of.
  const updatedMarker = `Reconcile updated ${Date.now()}`;
  await updatePageViaApi(userBPage.context(), { pageId, body: `# ${updatedMarker}\n` });

  // Visibility recovers while the presence socket is STILL severed — any
  // reconnect attempt the client makes is still refused by the route
  // above, so the only channel through which the update can appear is the
  // reconcile head-GET fired by the tab-revisit trigger.
  await setVisibility(userAPage, 'visible');

  // The body swaps in without a reload (no `page.reload()` / `page.goto()`
  // is ever called on `userAPage` after the initial navigation), and the
  // live-sync banner announces it the same way a live push would.
  await expect(userAPage.getByRole('heading', { name: updatedMarker })).toBeVisible({ timeout: 15_000 });
  await expect(userAPage.getByTestId('live-sync-banner')).toBeVisible();

  // Cleanup: let the presence socket reconnect normally so context
  // teardown doesn't leave a route perpetually refusing connections.
  presenceSocket.restore();
});
