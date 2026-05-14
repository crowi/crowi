import { resolveApiDistFile } from './api-dist';
import { buildCollabRedisOpts } from './redis-opts';

/**
 * Collab-side wrapper around the api package's editor cap counter
 * (RFC-0003 Phase 6). Loads `createEditorCapCounter` from the api dist
 * so the Redis key naming + cap math is shared with the wsToken
 * issuance path — a drift between api `peek` and collab `tryAcquire`
 * would silently break the "21st client" UX.
 *
 * Why route through the api dist instead of re-implementing here?
 *
 *   - Single source of truth for the Redis key prefix
 *     (`crowi:collab:editors:<pageId>`), the entry format
 *     (`<userId>:<socketId>`), and the per-key TTL (24h sliding).
 *   - Future tweaks (Lua atomicity, alternate data types) land in
 *     one place.
 *
 * Why a *separate* Redis client (not the pageEvent publisher's)?
 *
 *   - node-redis v4 doesn't allow pub/sub mode and regular commands
 *     on the same connection. The pageEvent publisher (Phase 5)
 *     stays in publish-mode; the cap counter needs SADD / SCARD /
 *     SREM, which are blocking commands on the regular command bus.
 *   - Separating clients also keeps the cap path latency-isolated:
 *     `tryAcquire` runs on the websocket handshake hot path, and we
 *     don't want a slow pub/sub flush to delay an editor connection.
 *
 * Type-surface: mirrored locally rather than imported from
 * `@crowi/api/dist/...` (subpath that isn't exposed in the api
 * `package.json#exports` map). Matches the `ws-token.ts` /
 * `collab-cap.ts` pattern of declaring a thin shape alongside the
 * runtime `require` of the api dist file.
 */

export interface TryAcquireResult {
  acquired: boolean;
  count: number;
  cap: number;
}

export interface EditorCapCounter {
  readonly maxEditorsPerPage: number;
  peek(pageId: string): Promise<{ count: number; cap: number }>;
  tryAcquire(pageId: string, userId: string, socketId: string): Promise<TryAcquireResult>;
  release(pageId: string, userId: string, socketId: string): Promise<void>;
  disconnect(): Promise<void>;
}

interface ApiEditorCapCounterOptions {
  redisOpts?: Record<string, unknown> | null;
  maxEditorsPerPage?: number;
}

interface ApiEditorCapCounterModule {
  createEditorCapCounter(opts?: ApiEditorCapCounterOptions): Promise<EditorCapCounter>;
  parseCapEnv(value: string | undefined): number;
  DEFAULT_MAX_EDITORS: number;
}

let cachedApiCounter: ApiEditorCapCounterModule | null = null;
function loadApiCounter(): ApiEditorCapCounterModule {
  if (cachedApiCounter) return cachedApiCounter;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cachedApiCounter = require(resolveApiDistFile('util/editor-cap-counter.js')) as ApiEditorCapCounterModule;
  return cachedApiCounter;
}

/**
 * Re-export of the api util's `parseCapEnv` so collab boot code shares
 * the same `COLLAB_MAX_EDITORS_PER_PAGE` parse semantics (= empty /
 * non-numeric / non-positive → `DEFAULT_MAX_EDITORS`).
 */
export const parseCapEnv = (value: string | undefined): number => loadApiCounter().parseCapEnv(value);

/** Re-export of the api util's `DEFAULT_MAX_EDITORS` so collab no-op fallback shares the same cap. */
export const DEFAULT_MAX_EDITORS: number = (() => loadApiCounter().DEFAULT_MAX_EDITORS)();

export interface CreateCollabEditorCapCounterOptions {
  /** `REDIS_URL` (or `REDIS_TLS_URL`). When null/undefined we return a no-op counter (cap disabled). */
  redisUrl?: string | null;
  /** Mirrors `REDIS_REJECT_UNAUTHORIZED=0` semantics for rediss:// self-signed certs in dev. */
  redisRejectUnauthorized?: boolean;
  /** Override the cap; defaults to 20 inside the api util. */
  maxEditorsPerPage?: number;
}

/**
 * No-op counter used when callers (notably tests) don't inject a real
 * counter. Mirrors the no-op shape that the api util's
 * `createEditorCapCounter` returns when `redisOpts` is null, so callers
 * can rely on `peek` / `tryAcquire` / `release` always being
 * well-defined functions.
 */
export const noopEditorCapCounter: EditorCapCounter = {
  get maxEditorsPerPage() {
    return DEFAULT_MAX_EDITORS;
  },
  async peek() {
    return { count: 0, cap: DEFAULT_MAX_EDITORS };
  },
  async tryAcquire() {
    return { acquired: true, count: 0, cap: DEFAULT_MAX_EDITORS };
  },
  async release() {
    /* nothing */
  },
  async disconnect() {
    /* nothing */
  },
};

/**
 * Build the collab process's editor cap counter. Failure modes
 * (REDIS_URL unset, connect fail) degrade to the api util's no-op
 * counter — same fail-open posture as the api side so a Redis outage
 * doesn't lock connections out.
 *
 * Style note: this factory is called **once** at boot (see
 * `index.ts:startCollabServer`), unlike the per-call cache used by
 * `ws-token.ts` / `collab-cap.ts` / `presence.ts`. We let the caller
 * own the lifetime so `shutdown()` can `await counter.disconnect()`
 * deterministically before `mongoose.disconnect()`.
 */
export async function createCollabEditorCapCounter(opts: CreateCollabEditorCapCounterOptions): Promise<EditorCapCounter> {
  const redisOpts = buildCollabRedisOpts(opts.redisUrl ?? null, opts.redisRejectUnauthorized ?? true);
  return loadApiCounter().createEditorCapCounter({
    redisOpts,
    maxEditorsPerPage: opts.maxEditorsPerPage,
  });
}
