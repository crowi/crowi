import { resolveApiDistFile } from './api-dist';

/**
 * Pull `buildRedisOpts` from `@crowi/api/dist/util/redis-opts.js` once
 * and cache the function reference at module scope. Every collab-side
 * Redis client (pageEventPublisher / editorCapCounter / future ones)
 * goes through this wrapper so the api-dist `require` ceremony lives
 * in exactly one place — same posture as `ws-token.ts` / `collab-cap.ts`.
 *
 * Keeping the cache at module scope (rather than inside the export) is
 * safe because `resolveApiDistFile` is pure and the api util is itself
 * a pure function — no Crowi instance or process state is captured.
 */
interface ApiRedisOptsModule {
  buildRedisOpts(redisUrl: string | null, rejectUnauthorized: boolean): Record<string, unknown> | null;
}

let cachedBuildRedisOpts: ApiRedisOptsModule['buildRedisOpts'] | null = null;

function getBuildRedisOpts(): ApiRedisOptsModule['buildRedisOpts'] {
  if (cachedBuildRedisOpts) return cachedBuildRedisOpts;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolveApiDistFile('util/redis-opts.js')) as ApiRedisOptsModule;
  cachedBuildRedisOpts = mod.buildRedisOpts;
  return cachedBuildRedisOpts;
}

/**
 * Translate a Crowi `REDIS_URL` (`redis://` or `rediss://`) into a
 * node-redis v4 `socket`-shaped config, defaulting `rejectUnauthorized`
 * to `true` (= verify TLS unless the operator explicitly opts out via
 * `REDIS_REJECT_UNAUTHORIZED=0`). Returns `null` when `redisUrl` is
 * falsy so callers can branch on "Redis not configured" without a
 * sentinel.
 */
export function buildCollabRedisOpts(redisUrl: string | null, rejectUnauthorized = true): Record<string, unknown> | null {
  return getBuildRedisOpts()(redisUrl, rejectUnauthorized);
}
