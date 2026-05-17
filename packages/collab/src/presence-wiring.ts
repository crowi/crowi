import type { onDisconnectPayload } from '@hocuspocus/server';
import type { CollabContext } from './types';
import { type PresenceHooks, noopPresenceHooks } from './presence';

/**
 * RFC-0005 — collab → presence wiring helpers.
 *
 * Pure hook-wrapper factories, kept in their own file (no
 * `@hocuspocus/server` *runtime* import — only the erased
 * `onDisconnectPayload` *type*) so the collab Jest suite can unit-test
 * the wiring directly. `server.ts` cannot be imported under Jest
 * because `@hocuspocus/server` pulls in `crossws`'s ESM-only bundle;
 * isolating the wiring here keeps it testable.
 *
 * Both wrappers fire presence calls **fire-and-forget**: presence is
 * advisory page-view UI, and a presence failure (Redis down, etc.)
 * must never block or break a collab connection.
 */

/**
 * Wrap an `onAuthenticate` hook so `presence.markEditing` fires once
 * authentication resolves a `CollabContext`. The returned wrapper has
 * the exact signature of the base hook.
 *
 * The payload type is constrained to carry a `socketId` (the
 * `onAuthenticatePayload` Hocuspocus passes always does) so the
 * per-connection editing signal can be keyed by it — a user with two
 * editor tabs gets two distinct signals, and closing one tab does not
 * clear the badge while the other is still editing.
 */
export function wrapOnAuthenticateWithPresence<P extends { socketId: string }>(
  baseOnAuthenticate: (payload: P) => Promise<CollabContext>,
  presence: PresenceHooks = noopPresenceHooks,
): (payload: P) => Promise<CollabContext> {
  return async (payload: P): Promise<CollabContext> => {
    const ctx = await baseOnAuthenticate(payload);
    void presence.markEditing(ctx.pageId, ctx.userId, payload.socketId).catch((err: unknown) => {
      console.warn('[crowi:collab] presence.markEditing failed (non-blocking):', (err as Error).message);
    });
    return ctx;
  };
}

/**
 * Wrap an `onDisconnect` hook so `presence.unmarkEditing` fires once
 * the base hook (editor-cap release) completes. A connection that
 * never authenticated has no `context`, and thus no editing flag to
 * clear — those are skipped.
 */
export function wrapOnDisconnectWithPresence(
  baseOnDisconnect: (payload: onDisconnectPayload<CollabContext>) => Promise<void>,
  presence: PresenceHooks = noopPresenceHooks,
): (payload: onDisconnectPayload<CollabContext>) => Promise<void> {
  return async (payload: onDisconnectPayload<CollabContext>): Promise<void> => {
    await baseOnDisconnect(payload);
    const ctx = payload.context;
    if (ctx && ctx.pageId && ctx.userId) {
      void presence.unmarkEditing(ctx.pageId, ctx.userId, payload.socketId).catch((err: unknown) => {
        console.warn('[crowi:collab] presence.unmarkEditing failed (non-blocking):', (err as Error).message);
      });
    }
  };
}
