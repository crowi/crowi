import { buildRedisOpts } from './redis-opts';
import { createEditorCapCounter, parseCapEnv, type EditorCapCounter } from './editor-cap-counter';

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
 * file means the Phase 6 swap touches:
 *
 *   - `util/editor-cap-counter.ts` (new — Redis primitives)
 *   - `util/collab-cap.ts`         (this — promoted from stub to
 *                                   `peek`-based check)
 *
 * The route handler (`routes/ts-rest/page-collab.ts`) is unchanged.
 *
 * `peek` (read-only) is used here on purpose: a `tryAcquire` would
 * SADD a token-issuance attempt that may never actually connect
 * (browser tab closed before the WebSocket handshake), inflating the
 * count. The real acquire happens later in `onAuthenticate` (Phase 6
 * defence-in-depth on the collab side), where the WebSocket has
 * already opened and we have a real `socketId` to scope the SADD
 * entry to.
 *
 * Env-direct config: `REDIS_URL` / `REDIS_TLS_URL` /
 * `REDIS_REJECT_UNAUTHORIZED` / `COLLAB_MAX_EDITORS_PER_PAGE` are
 * read once per process at first call. This mirrors `ws-token.ts`'s
 * env posture so the Hocuspocus process (which imports this util via
 * `api-dist`) and the api process see the same configuration source.
 *
 * Fail-open posture: if `REDIS_URL` is unset or the connect fails,
 * the underlying counter returns 0 from `peek` and this helper falls
 * through to `{ readonly: false }`. The cap is a soft limit by design
 * (spec §Phase 6); a Redis outage must not lock out *all* editors.
 */

let cachedCounter: Promise<EditorCapCounter> | null = null;

/**
 * Resolve (and cache) the process-wide editor cap counter. Lazy so the
 * api process can boot without an immediate Redis round-trip; the
 * counter materialises on the first `checkEditorCap` call (= first
 * yjs-token issuance).
 *
 * Concurrent-first-caller dedup: the cache stores the in-flight
 * `Promise<EditorCapCounter>`, not the resolved counter. `createEditorCapCounter`
 * returns a Promise **synchronously** before its first internal `await`
 * yields, and the cache assignment runs in the same synchronous tick —
 * any concurrent `getCounter()` calls observe the cached promise and
 * race onto the same connection attempt rather than each opening their
 * own client.
 */
function getCounter(): Promise<EditorCapCounter> {
  if (cachedCounter) return cachedCounter;
  const redisUrl = process.env.REDIS_TLS_URL ?? process.env.REDIS_URL ?? null;
  const rejectUnauthorized = process.env.REDIS_REJECT_UNAUTHORIZED !== '0';
  cachedCounter = createEditorCapCounter({
    redisOpts: buildRedisOpts(redisUrl, rejectUnauthorized),
    maxEditorsPerPage: parseCapEnv(process.env.COLLAB_MAX_EDITORS_PER_PAGE),
  });
  return cachedCounter;
}

/**
 * Probe the editor cap for the given page. Returns `{ readonly: true }`
 * when the current Redis-tracked editor count is at or above the cap.
 *
 * Signature kept identical to the Phase 2 stub so `page-collab.ts`
 * stays untouched.
 */
export const checkEditorCap = async (pageId: string): Promise<{ readonly: boolean }> => {
  const counter = await getCounter();
  const { count, cap } = await counter.peek(pageId);
  return { readonly: count >= cap };
};

/**
 * Test helper — set the cached counter or reset to lazy. Pass a
 * pre-built fake to exercise the cap-reached path without Redis; pass
 * `null` to clear the cache so a fresh env is honoured on the next
 * call. Combines the previously-separate `_reset…` / `_set…` helpers
 * into one entry point.
 */
export const _setEditorCapCounterForTesting = (counter: EditorCapCounter | null): void => {
  cachedCounter = counter == null ? null : Promise.resolve(counter);
};
