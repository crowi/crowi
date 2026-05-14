import type { onDisconnectPayload } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabContext } from '../types';
import { type EditorCapCounter, noopEditorCapCounter } from '../editor-cap';

const debug = Debug('crowi:collab:disconnect');

export interface OnDisconnectDeps {
  /**
   * Editor cap counter — `release` SREM's the SADD entry that
   * `onAuthenticate` placed on connect. Defaults to a no-op counter
   * so tests that don't care about cap can omit it; production
   * injects the real Redis-backed counter via `startCollabServer`.
   */
  editorCapCounter?: EditorCapCounter;
}

/**
 * Build the Hocuspocus `onDisconnect` hook (RFC-0003 Phase 6).
 *
 * Pairs with `onAuthenticate`'s `tryAcquire`. Removes the editor's
 * entry from the per-page Redis set so the next connection can take
 * its slot.
 *
 * Invariants:
 *
 *   - Readonly contexts SKIP release. They never acquired a slot in
 *     `onAuthenticate` (readonly path bypasses `tryAcquire`), so an
 *     SREM here would silently remove someone else's entry on key
 *     collision — that "21st client" disconnect would otherwise eat
 *     a legitimate editor's slot. The SREM is also semantically
 *     meaningless because the readonly entry was never SADD'd.
 *
 *   - Hocuspocus fires this for every connection close, including
 *     abnormal (network drop, browser kill). The cap counter's per-
 *     key 24h TTL bounds the worst-case overcount when this hook
 *     doesn't run (process crash) to the same window.
 *
 *   - Errors are swallowed (warn-only). A `release` failure has no
 *     user-visible impact — the TTL eventually evicts the stale
 *     entry — and we never want the hook to throw into Hocuspocus's
 *     log stream during normal disconnects.
 */
export function createOnDisconnect(deps: OnDisconnectDeps) {
  const editorCapCounter = deps.editorCapCounter ?? noopEditorCapCounter;

  return async (data: onDisconnectPayload<CollabContext>): Promise<void> => {
    const { context, socketId, documentName } = data;

    // `context` is populated by `onAuthenticate`; if the connection
    // died before authentication ran (extremely rare) there's nothing
    // to release.
    if (!context || !context.userId) {
      debug('skip release: no context (auth never completed) for socket %s', socketId);
      return;
    }

    if (context.readonly) {
      debug('skip release: readonly connection (page=%s user=%s)', context.pageId, context.userId);
      return;
    }

    try {
      await editorCapCounter.release(context.pageId, context.userId, socketId);
      debug('released page=%s user=%s socket=%s document=%s', context.pageId, context.userId, socketId, documentName);
    } catch (err) {
      // editorCapCounter.release already swallows its own errors, but
      // catch defensively so a programming error here can't break
      // Hocuspocus's disconnect path.
      console.warn('[crowi:collab] onDisconnect: release failed (non-blocking):', (err as Error).message);
    }
  };
}
