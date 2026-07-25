import { redactUserinfo } from './redact-userinfo';

/**
 * Parse the `database`/`db` index a `REDIS_URL` selects from its URI
 * pathname, shared by:
 *   - `util/env-schema.ts`'s `validateRedisUrl()` (fail-fast boot validation)
 *   - `util/redis-opts.ts`'s `buildRedisOpts()` (node-redis v4 `database`)
 *   - `collab/extension-redis.ts`'s `parseRedisUrlForIoredis()` (ioredis `db`)
 *
 * A single shared parser is the point: node-redis and ioredis previously
 * each dropped the pathname on the floor (both silently connected to DB 0
 * regardless of `redis://host:6379/1`), and having them call the same
 * function is what guarantees they can never independently drift on which
 * DB a given `REDIS_URL` selects (feature-redis-key-prefix §3).
 *
 * This is a SECONDARY, purely numeric isolation axis — it is NOT a
 * substitute for `util/redis-keyspace.ts`'s instance-scoped key/channel
 * prefix. Redis pub/sub is not scoped to a DB (`SUBSCRIBE`/`PUBLISH` match
 * across every DB on the same server), so two instances that only differ by
 * `REDIS_URL` pathname still cross-talk on shared channels.
 */

/** The pathname must be exactly `/` (or absent) — DB 0 — or `/<non-negative integer>`. Anything else (`/foo`, `/-1`, `/1/extra`, ...) is invalid. */
const DB_PATHNAME_PATTERN = /^\/(\d+)$/;

export type ParsedRedisDatabase = { readonly database: number } | { readonly error: string };

/**
 * Parses the database index out of a full `redis://`/`rediss://` URL.
 * Callers that already hold a parsed `URL` (see `buildRedisOpts` /
 * `parseRedisUrlForIoredis`) still pass the original string here — a
 * second `new URL()` call is cheap and keeps this function trivially
 * testable against plain strings without threading a `URL` instance
 * through every call site.
 *
 * `new URL()` itself can throw — a value that passes `env-schema.ts`'s
 * `/^rediss?:\/\//` scheme prefix check (e.g. an unclosed IPv6 host literal,
 * an embedded space) is not necessarily a syntactically valid URL. That
 * throw is caught here and folded into the same `{ error }` shape as an
 * invalid pathname, so every caller — including `validateRedisUrl()`, which
 * aggregates this into the boot-time `failMessages` list alongside every
 * other invalid env var — gets one consistent non-throwing contract instead
 * of `new URL()`'s exception escaping the normal aggregated-message path.
 */
export function parseRedisDatabase(redisUrl: string): ParsedRedisDatabase {
  let pathname: string;
  try {
    ({ pathname } = new URL(redisUrl));
  } catch {
    return { error: `must be a valid URL (got ${JSON.stringify(redactUserinfo(redisUrl))})` };
  }

  // Both an entirely absent path (`redis://host:6379`) and an explicit root
  // (`redis://host:6379/`) mean "no override" — DB 0, node-redis/ioredis's
  // own default.
  if (pathname === '' || pathname === '/') {
    return { database: 0 };
  }

  const match = DB_PATHNAME_PATTERN.exec(pathname);
  if (match == null) {
    return {
      error: `database pathname must be "/" (database 0) or "/<non-negative integer>" (e.g. "/1") — got ${JSON.stringify(pathname)}`,
    };
  }

  return { database: Number.parseInt(match[1], 10) };
}

/** Narrows {@link ParsedRedisDatabase} to its success shape. */
export function isValidRedisDatabase(parsed: ParsedRedisDatabase): parsed is { readonly database: number } {
  return 'database' in parsed;
}

/**
 * {@link parseRedisDatabase}, but throws instead of returning the error
 * shape — the form both client-building call sites (`util/redis-opts.ts`'s
 * `buildRedisOpts()` and `collab/extension-redis.ts`'s
 * `parseRedisUrlForIoredis()`) want, since `env-schema.ts`'s
 * `validateRedisUrl()` already runs `parseRedisDatabase()` at boot and
 * fails BEFORE either of those functions is ever reached in production.
 * Reaching this throw means either that validation was bypassed (e.g. a
 * test constructing options directly) or a future refactor regression —
 * throwing here instead of silently falling back to DB 0 keeps both
 * callers consistent with §3's "no implementation-dependent implicit
 * fallback" rule.
 */
export function parseRedisDatabaseOrThrow(redisUrl: string): number {
  const parsed = parseRedisDatabase(redisUrl);
  if ('error' in parsed) {
    throw new Error(`invalid REDIS_URL database pathname: ${parsed.error}`);
  }
  return parsed.database;
}
