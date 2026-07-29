import type Crowi from 'src/crowi';
import { createEditorCapCounter, parseCapEnv, type EditorCapCounter } from './editor-cap-counter';
import { resolveRedisKeyspaceIfEnabled } from './redis-keyspace';

/**
 * Editor cap check used by the wsToken issuance endpoint
 * (`GET /api/v2/pages/:id/yjs-token`, Phase 2). RFC-0003 Phase 6
 * promotes the Phase 2 stub to a Redis-backed check via the shared
 * `editor-cap-counter` util.
 *
 * Why a thin wrapper here instead of using the counter directly in
 * the route handler? The wsToken handler shouldn't know about Redis
 * — it asks a domain-shaped question ("is this connection at cap?")
 * and gets a boolean back. Keeping the swap-point isolated in this
 * file means the Phase 9 same-process attach work touches:
 *
 *   - `util/editor-cap-counter.ts` (signature: `redisOpts` → `redisClient`)
 *   - `util/collab-cap.ts`         (this — reads `crowi.redis`)
 *
 * The route handler (`routes/ts-rest/page-collab.ts`) is unchanged
 * apart from passing `crowi` into the call.
 *
 * `peek` (read-only) is used here on purpose: a `tryAcquire` would
 * SADD a token-issuance attempt that may never actually connect
 * (browser tab closed before the WebSocket handshake), inflating the
 * count. The real acquire happens later in `onAuthenticate` (Phase 6
 * defence-in-depth on the embedded Hocuspocus side; see
 * `src/collab/attach.ts`), where the WebSocket has already opened
 * and we have a real `socketId` to scope the SADD entry to.
 *
 * Fail-open posture: if `crowi.redis` is null (REDIS_URL unset) the
 * underlying counter returns 0 from `peek` and this helper falls
 * through to `{ readonly: false }`. The cap is a soft limit by
 * design (spec §Phase 6); a Redis outage must not lock out *all*
 * editors.
 */

let cachedCounter: Promise<EditorCapCounter> | null = null;

/**
 * Resolve (and cache) the process-wide editor cap counter. Lazy so
 * the api process can boot without an immediate Redis round-trip;
 * the counter materialises on the first call (= first yjs-token
 * issuance or first WebSocket attach, whichever comes first).
 *
 * Concurrent-first-caller dedup: the cache stores the in-flight
 * `Promise<EditorCapCounter>`, not the resolved counter. Any
 * concurrent caller observes the cached promise and races onto the
 * same counter rather than each opening their own.
 *
 * Exported so the embedded Hocuspocus engine (`collab/attach.ts`)
 * and the wsToken HTTP handler share **one** counter instance — same
 * Redis keys, same in-process cache, same future Lua-atomic upgrade
 * path.
 */
export function getEditorCapCounter(crowi: Crowi): Promise<EditorCapCounter> {
  if (cachedCounter) return cachedCounter;
  cachedCounter = createEditorCapCounter({
    redisClient: crowi.redis ?? null,
    maxEditorsPerPage: parseCapEnv(process.env.COLLAB_MAX_EDITORS_PER_PAGE),
    // Instance-scoped (feature-redis-key-prefix §1/§2), matching
    // `service/presence.ts`'s `getPresenceService` / `util/rate-limit.ts`'s
    // call sites.
    keyspace: resolveRedisKeyspaceIfEnabled(crowi),
  });
  return cachedCounter;
}

/**
 * Probe the editor cap for the given page. Returns `{ readonly: true }`
 * when the current Redis-tracked editor count is at or above the cap.
 *
 * Phase 9 signature change: now takes a `Crowi` instance so the
 * counter can be built against the shared `crowi.redis` client. The
 * collab attach helper builds its own counter independently with
 * the same client, but both wrappers eventually flow through the
 * same Redis keys.
 */
export const checkEditorCap = async (crowi: Crowi, pageId: string): Promise<{ readonly: boolean }> => {
  const counter = await getEditorCapCounter(crowi);
  const { count, cap } = await counter.peek(pageId);
  return { readonly: count >= cap };
};

/**
 * Test helper — set the cached counter or reset to lazy. Pass a
 * pre-built fake to exercise the cap-reached path without Redis; pass
 * `null` to clear the cache so a fresh env is honoured on the next
 * call.
 */
export const _setEditorCapCounterForTesting = (counter: EditorCapCounter | null): void => {
  cachedCounter = counter == null ? null : Promise.resolve(counter);
};
