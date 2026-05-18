import Debug from 'debug';

const debug = Debug('crowi:collab:presence');

/**
 * Presence integration surface (RFC-0005).
 *
 * `@crowi/collab` is deliberately crowi-agnostic — it never imports
 * `@crowi/api`. The real presence implementation (Redis viewer hash +
 * pub/sub) lives on the api side as `service/presence.ts`; the api's
 * `attachCollabServer` injects an adapter satisfying this interface
 * via `createCollabServer`'s `presence` option.
 *
 *   - `markEditing`   — called from `onAuthenticate` once a collab
 *                       wsToken verifies. The api adapter records a
 *                       short-lived editing signal (keyed by the
 *                       connection's `socketId`) so the editing user
 *                       picks up an `✏️` badge in the page-presence row.
 *   - `unmarkEditing` — called from `onDisconnect`. Symmetric: the
 *                       signal is cleared so the badge disappears on
 *                       the next presence broadcast.
 *
 * `socketId` is the per-connection identity Hocuspocus assigns; it
 * disambiguates a single user with multiple editor tabs so closing one
 * tab does not clear the badge while another is still editing.
 *
 * Both are best-effort: a presence failure must never block or break a
 * collab connection.
 */
export interface PresenceHooks {
  markEditing(pageId: string, userId: string, socketId: string): Promise<void>;
  unmarkEditing(pageId: string, userId: string, socketId: string): Promise<void>;
}

/**
 * Default no-op presence hooks. Used when the host process does not
 * inject a real implementation — single-instance dev without the api's
 * presence service, and the collab unit tests. Keeps the
 * `onAuthenticate` / `onDisconnect` call sites stable without forcing
 * every caller to supply a presence adapter.
 */
export const noopPresenceHooks: PresenceHooks = {
  async markEditing(pageId: string, userId: string, socketId: string): Promise<void> {
    if (!pageId || !userId) {
      console.warn(`[crowi:collab:presence] markEditing called with empty arg (pageId=${pageId}, userId=${userId})`);
      return;
    }
    debug('markEditing(page=%s, user=%s, socket=%s) [noop — no presence adapter injected]', pageId, userId, socketId);
  },
  async unmarkEditing(pageId: string, userId: string, socketId: string): Promise<void> {
    if (!pageId || !userId) {
      console.warn(`[crowi:collab:presence] unmarkEditing called with empty arg (pageId=${pageId}, userId=${userId})`);
      return;
    }
    debug('unmarkEditing(page=%s, user=%s, socket=%s) [noop — no presence adapter injected]', pageId, userId, socketId);
  },
};
