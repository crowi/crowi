import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

// `redis-smoke-sentinel.js` is plain CJS with no type declarations —
// required directly rather than imported (same pattern
// `crowi-environment.test.ts` uses for `test-mongo-sentinel.js`; `allowJs`
// is on for `packages/api`, see `tsconfig.json`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sentinel = require('./redis-smoke-sentinel') as {
  REDIS_SMOKE_TARGETS: Record<'shared' | 'config' | 'tls', string>;
  REDIS_SMOKE_CATEGORIES: readonly RedisSmokeCategory[];
  readConnectivitySentinel: () => Partial<Record<'shared' | 'config' | 'tls', { url: string; reachable: boolean }>> | null;
  writeMarker: (category: RedisSmokeCategory) => void;
};

/**
 * feature-redis-8-upgrade Phase 2 — shared helper for the 8 real-Redis
 * smoke test files (`*.smoke.test.ts`). Two responsibilities:
 *
 *   1. Expose each smoke file's `describe`/`describe.skip` decision for the
 *      3 Redis targets Phase 1 landed, read SYNCHRONOUSLY (at test-file
 *      COLLECTION time — before any `describe`/`it` call in the importing
 *      file runs) from the connectivity sentinel `global-setup.js` writes
 *      exactly once, in the jest main process, before any worker forks.
 *      This is what lets a smoke file use plain `describe.skip(...)`
 *      instead of an ad hoc runtime early-return: the reachability decision
 *      already happened by the time this module's top-level code runs, so
 *      it can be a normal synchronous constant.
 *   2. Run-scoped id generators + the category-marker writer
 *      (`markRedisSmokeRan`) each smoke file's `beforeAll` calls once, so
 *      `global-teardown.js` can prove (race-free, after every worker
 *      finished) that all 8 categories actually ran in CI.
 *
 * See `redis-smoke-sentinel.js` for the full connectivity-sentinel /
 * marker-file protocol this builds on.
 */

export type RedisSmokeCategory = 'collab' | 'editor-cap' | 'presence' | 'notifications' | 'config' | 'rate-limit' | 'lru' | 'link-completion' | 'boot';

/** The 3 Redis connection targets Phase 1 provisioned. */
export const REDIS_SMOKE_URLS: Readonly<Record<'shared' | 'config' | 'tls', string>> = sentinel.REDIS_SMOKE_TARGETS;

interface RedisSmokeReachability {
  shared: boolean;
  config: boolean;
  tls: boolean;
}

/**
 * Read once, at module-load time (= each `*.smoke.test.ts` file's
 * collection time). `global-setup.js` has ALREADY run to completion in the
 * jest main process by the time any worker forks and requires this file
 * (see `test-mongo-sentinel.js`'s doc comment for the underlying
 * jest-internals guarantee), so the connectivity sentinel is always present
 * — except for a genuine env-propagation break, handled below the same way
 * `crowi-environment.js` handles a missing/corrupt Mongo sentinel: warn
 * loudly and degrade to "nothing reachable" rather than throwing (a smoke
 * *test* module failing to import must never itself become the failure
 * mode — the CI fail-fast for a genuine Redis outage already happened
 * inside `global-setup.js` itself, before this point).
 */
function resolveReachability(): RedisSmokeReachability {
  const record = sentinel.readConnectivitySentinel();
  if (!record) {
    // eslint-disable-next-line no-console
    console.warn(
      '[test] redis-smoke: connectivity sentinel missing/corrupt — global-setup.js should have written it before ' +
        'any worker forked. Treating every Redis smoke target as unreachable (skip) for this file.',
    );
    return { shared: false, config: false, tls: false };
  }
  return {
    shared: record.shared?.reachable ?? false,
    config: record.config?.reachable ?? false,
    tls: record.tls?.reachable ?? false,
  };
}

export const redisSmokeReachable: RedisSmokeReachability = resolveReachability();

/**
 * `CROWI_TEST_RUN_ID` — always set by the time this module loads (inherited
 * from `global-setup.js`, which assigns it before any worker forks; see
 * `test-mongo-sentinel.js`'s doc comment). Used to namespace every key /
 * channel / documentName / userId / pageId a smoke test touches so
 * concurrent worktrees / CI jobs sharing the same Redis instance (per
 * CLAUDE.md's "worktree 間で共有される Redis" note) never collide.
 */
function redisSmokeRunId(): string {
  return sentinel.requireRunId();
}

/**
 * A run-and-call unique id for a smoke test's own key/channel/documentName/
 * userId/pageId. Combines the run id (cross-worktree/CI-job isolation) with
 * a fresh random suffix (cross-`it()`-within-the-same-file isolation, since
 * several tests in one smoke file may share a category).
 */
export function uniqueRedisSmokeId(label: string): string {
  return `${label}-${redisSmokeRunId()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Record that `category`'s smoke `describe` block actually ran (not
 * `.skip`-ped). Call once, in that file's top-level `beforeAll` — jest never
 * invokes `beforeAll` for a skipped `describe`, so a marker landing on disk
 * is itself the proof. `global-teardown.js` aggregates these after every
 * worker finished and CI-gates on the count (see that module's doc
 * comment).
 */
export function markRedisSmokeRan(category: RedisSmokeCategory): void {
  sentinel.writeMarker(category);
}

/**
 * Poll `predicate` every 25ms until it's true or `timeoutMs` elapses.
 * Shared by the smoke files that assert on an async pub/sub relay landing
 * (config / presence / notifications) — each previously carried its own
 * near-identical copy of this loop.
 */
export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Open a real node-redis v4 client against `url`, run `fn`, and always
 * disconnect — the connect/try/finally/disconnect boilerplate shared
 * verbatim by every smoke file that only needs one ad hoc client for its
 * whole test body (lru / editor-cap-counter / rate-limit).
 */
export async function withRedisClient<T>(url: string, fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient({ url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
