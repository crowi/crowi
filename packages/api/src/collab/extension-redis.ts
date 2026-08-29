import url from 'node:url';
import Debug from 'debug';
import type { Extension } from '@hocuspocus/server';
import type Crowi from 'src/crowi';
import { parseRedisDatabaseOrThrow } from 'src/util/redis-database';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';

const debug = Debug('crowi:collab:extension-redis');

/**
 * Namespace for the Redis keys + pub/sub channels owned by
 * `@hocuspocus/extension-redis`, resolved through the shared instance
 * keyspace (feature-redis-key-prefix §1/§2 — `crowi:<instance-slug>:collab`).
 * The extension's own prefix is concatenated with sub-keys like
 * `:awareness:<docname>` / `:y-update:<docname>`, so this prefix is
 * **disjoint** from the editor cap counter's keyspace
 * (`crowi:<instance-slug>:collab:editors:<pageId>` — the `editors` segment
 * is the discriminator). Documenting the carve-up here so a future
 * operator-side prefix override doesn't accidentally collide.
 */
function collabRedisPrefix(crowi: Crowi): string {
  return resolveRedisKeyspace(crowi).prefix('collab');
}

/**
 * Build the `@hocuspocus/extension-redis` instance the api injects into
 * `createCollabServer` for cross-instance pub/sub of Y.Doc updates +
 * awareness state. Returns `null` when this api process is not wired
 * to Redis (`crowi.redis === null` ⇔ `REDIS_URL` unset) — single-
 * instance dev keeps working unchanged.
 *
 * Design (Phase 9):
 * - api uses node-redis v4 (`crowi.redis`); the extension expects
 *   ioredis. The two clients can't be shared, so the extension creates
 *   its own pub + sub ioredis clients via the `createClient` callback
 *   we hand it. `crowi.redisUrl` is parsed into the host/port/auth/tls
 *   shape ioredis accepts.
 * - `identifier` is `process.env.HOSTNAME ?? crowi-<pid>`. In docker /
 *   k8s `HOSTNAME` is set to the container / pod name automatically,
 *   which is the right cross-instance discriminator; bare-metal dev
 *   falls back to the pid.
 * - When `REDIS_URL` is set but `crowi.redis === null` (boot warned
 *   that Redis is unreachable), we still skip the extension —
 *   `crowi.redis` is the single source of truth for "Redis is
 *   actually usable from this process".
 */
export function buildCollabRedisExtension(crowi: Crowi): Extension | null {
  // `crowi.redis` is the api's node-redis client; null when REDIS_URL
  // is unset OR when the boot-time connection failed. Either way we
  // can't safely run the extension here — fall back to single-instance
  // mode and let the operator notice the boot-time Redis warning.
  if (crowi.redis === null) {
    debug('skip extension-redis: crowi.redis is null (single-instance mode)');
    return null;
  }
  if (!crowi.redisUrl) {
    // Defensive: `crowi.redis` non-null without `redisUrl` should be
    // unreachable today, but guard so a future refactor that injects
    // a client without an URL doesn't silently mint an extension with
    // no connection target. `debug` instead of `console.warn` because
    // this only fires on bug, not on operator misconfiguration.
    debug('skip extension-redis: crowi.redis set but redisUrl missing (likely a refactor regression)');
    return null;
  }

  // Always include `pid` so two api processes on the same host (= same
  // `HOSTNAME`, common in systemd / bare-metal multi-worker setups)
  // don't dedupe their extension-redis broadcasts under the same
  // identifier. In docker / k8s the `HOSTNAME` part is the container
  // / pod id and pid is typically `1`, but the suffix keeps the shape
  // consistent across runtimes.
  const identifier = `${process.env.HOSTNAME ?? 'crowi'}-${process.pid}`;
  const ioredisOptions = parseRedisUrlForIoredis(crowi.redisUrl);
  const prefix = collabRedisPrefix(crowi);

  // Lazy `require()` so this module's TS surface doesn't pull
  // `@hocuspocus/extension-redis` into Jest's CJS loader at test
  // collect time (the package's transitive dep graph is fine, but
  // keeping the require local matches the pattern used for
  // `@crowi/collab` in `attach.ts`). `ioredis` is loaded the same way
  // — we don't import it statically because it's a transitive dep of
  // the extension (no @types/ioredis needed in api's package.json).
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { Redis: RedisExtension } = require('@hocuspocus/extension-redis') as typeof import('@hocuspocus/extension-redis');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  const IORedisModule = require('ioredis') as any;
  // ioredis exports both CJS (default) and ESM (named) shapes; pick
  // whichever the loader handed us.
  const IORedisCtor: new (opts: unknown) => unknown = IORedisModule.default ?? IORedisModule.Redis ?? IORedisModule;

  debug('attaching extension-redis (identifier=%s, prefix=%s)', identifier, prefix);

  return new RedisExtension({
    identifier,
    prefix,
    // The extension wants two long-lived ioredis connections (one for
    // PUB, one for SUB). The `createClient` callback is invoked twice
    // internally and we hand back a fresh ioredis client each time
    // pointing at the same Redis as `crowi.redis`.
    //
    // `lazyConnect: true` defers the TCP `connect()` until the
    // extension actually uses the client — without this, a slow /
    // misconfigured Redis would hang the api's `start()` (which
    // awaits `attachCollabServer`) indefinitely while ioredis retries
    // the initial socket. `connectTimeout: 10000` puts a hard ceiling
    // on individual connection attempts so a permanent outage surfaces
    // as a logged error instead of a silent stall.
    //
    // Cast on return because we intentionally don't drag ioredis
    // types into api's surface; `RedisInstance` (the extension's own
    // type) is structurally compatible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createClient: () => new IORedisCtor({ ...ioredisOptions, lazyConnect: true, connectTimeout: 10_000 }) as any,
  });
}

/**
 * Parse a `redis://` / `rediss://` URL into the option shape ioredis
 * accepts via its constructor.  Mirrors the field-level translation
 * `src/util/redis-opts.ts` does for node-redis v4, with ioredis-native
 * keys: `host`, `port`, `username`, `password`, `tls`, `db`. ioredis also
 * accepts a URL string directly but going through this parse lets us
 * apply the same `REDIS_REJECT_UNAUTHORIZED` env override the api's
 * primary client respects.
 *
 * `db` (feature-redis-key-prefix §3) is `redisUrl`'s pathname, parsed by
 * the shared `parseRedisDatabaseOrThrow()` so this and `util/redis-opts.ts`'s
 * `buildRedisOpts()` can never independently pick a different DB for the
 * same `REDIS_URL`. Exported (rather than kept module-private) so it can
 * be unit-tested directly instead of only indirectly through
 * `buildCollabRedisExtension()`'s `createClient` callback.
 */
export function parseRedisUrlForIoredis(redisUrl: string): {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: { rejectUnauthorized: boolean };
} {
  // WHATWG URL, not legacy url.parse — the legacy parser pre-decoded the
  // userinfo, double-decoding credentials and breaking passwords that
  // contain ':' or '@' (same defect class fixed in util/redis-opts.ts;
  // both parsers must stay credential-identical for the same REDIS_URL).
  const u = new URL(redisUrl);
  const host = u.hostname ? u.hostname.replace(/^\[|\]$/g, '') : '127.0.0.1';
  const portNumber = u.port ? Number.parseInt(u.port, 10) : 6379;

  const opts: ReturnType<typeof parseRedisUrlForIoredis> = { host, port: portNumber, db: parseRedisDatabaseOrThrow(redisUrl) };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') {
    const rejectUnauthorized = process.env.REDIS_REJECT_UNAUTHORIZED !== '0';
    opts.tls = { rejectUnauthorized };
  }
  return opts;
}
