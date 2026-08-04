import Debug from 'debug';
import { parseRedisDatabaseOrThrow } from './redis-database';

const debug = Debug('crowi:util:redis-opts');

/**
 * Translate a Crowi-style `REDIS_URL` (`redis://` or `rediss://` with
 * optional `user:password@host:port`) into a node-redis v4
 * `socket`-shaped config.
 *
 * The shape is intentionally compatible with `redis@4`'s
 * `createClient(opts)` so collab and api can negotiate identical TLS /
 * port / password semantics when both processes connect to the same
 * Redis instance. Returns `null` for an empty `redisUrl` so callers can
 * branch on "Redis not configured" without inventing a sentinel
 * elsewhere.
 *
 * Lives in `packages/api/src/util/` (not `service/`) so the collab
 * package can pull it through `api-dist.ts` without dragging in any
 * Crowi-class context.
 *
 * The top-level `database` field (feature-redis-key-prefix §3) is the
 * pathname of `redisUrl`, parsed by the shared `parseRedisDatabaseOrThrow()`
 * so this and `collab/extension-redis.ts`'s `parseRedisUrlForIoredis()` can
 * never independently pick a different DB for the same `REDIS_URL`. It is
 * a secondary, purely numeric isolation axis — NOT a substitute for
 * `util/redis-keyspace.ts`'s instance-scoped key/channel prefix, since
 * Redis pub/sub ignores the selected DB.
 */
export function buildRedisOpts(redisUrl: string | null, rejectUnauthorized: boolean): Record<string, unknown> | null {
  if (!redisUrl) return null;
  // WHATWG URL, not legacy url.parse: the legacy parser pre-DECODES the
  // userinfo into `auth`, which double-decodes credentials and destroys
  // the username:password boundary for passwords containing ':' or '@'.
  // WHATWG keeps `username` / `password` percent-encoded and split at the
  // right boundary — decode each exactly once here.
  //
  // Forward BOTH userinfo segments (mirroring collab's
  // parseRedisUrlForIoredis): node-redis v4 AUTHs with the top-level
  // `username` (ACL) — dropping it made the api client authenticate as
  // the `default` user while collab authenticated as the URL's ACL user,
  // on the very same REDIS_URL.
  const u = new URL(redisUrl);
  const credentials: { username?: string; password?: string } = {};
  if (u.username) credentials.username = decodeURIComponent(u.username);
  if (u.password) credentials.password = decodeURIComponent(u.password);
  const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 literals come bracketed from WHATWG hostname
  const portNumber = u.port ? parseInt(u.port, 10) : 6379;
  // node-redis v4 selects the TLS transport ONLY on the literal
  // `tls: true` (`options.tls === true` in @redis/client's socket.js), with
  // the tls.ConnectionOptions flattened into the same socket object
  // (`RedisTlsSocketOptions`). A nested `tls: {...}` object fails that
  // strict check and silently downgrades rediss:// to a plaintext socket.
  const tlsOpts = u.protocol === 'rediss:' ? { tls: true as const, requestCert: true, rejectUnauthorized } : null;

  return {
    socket: {
      host,
      port: portNumber,
      ...tlsOpts,
    },
    database: parseRedisDatabaseOrThrow(redisUrl),
    ...credentials,
  };
}

/**
 * Minimum node-redis v4 client surface {@link duplicateWithErrorHandler}
 * needs: `duplicate()` (returning the same client shape) plus the two
 * event names the helper attaches a listener to. Every module that owns a
 * duplicate pub/sub subscriber (presence / notifications) already declares
 * its own, richer structural client interface — those interfaces widen to
 * include this shape rather than this file importing theirs, keeping this
 * util free of any feature-specific dependency.
 */
interface DuplicatableRedisClient {
  duplicate(): this;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
}

/**
 * feature-redis-subscriber-crash-fix — the ONLY place in this codebase
 * (enforced by `.eslintrc.js`'s `no-restricted-syntax` guard) that may call
 * `client.duplicate()` to create a dedicated pub/sub subscriber.
 *
 * node-redis v4 puts a duplicated client into its own connection with its
 * own reconnect state machine, completely independent of the primary
 * client's `error` / `ready` listeners (`duplicate()` copies connection
 * OPTIONS, never event listeners). Without an `error` listener on the
 * duplicate itself, a steady-state Redis outage AFTER `connect()` succeeds
 * raises an unhandled EventEmitter `error` event and crashes the whole api
 * process — exactly what happened during the 2026-07-27 almoha production
 * Redis 7→8 restart, where `service/presence.ts` and
 * `notifications/attach.ts` each `.duplicate()`d a subscriber with no
 * `error` listener of its own.
 *
 * `client.duplicate()` is called with NO argument on purpose: node-redis
 * extends the primary's already-resolved connection options with a shallow
 * merge of the override object, so any top-level key the override sets
 * (`socket`, for instance) REPLACES the primary's value for that key wholesale
 * rather than merging into it — silently dropping whichever nested keys
 * (host / port / TLS) the override's own nested object didn't repeat. The
 * duplicate must inherit the primary's options unchanged.
 *
 * Both listeners are registered synchronously, on the object `duplicate()`
 * just returned — before the caller ever calls `connect()` on it — so no
 * `error` / `ready` event the duplicate emits can be missed. This helper
 * does not call `connect()` / `subscribe()` / `unsubscribe()` /
 * `disconnect()` itself: lifecycle ownership (initial connect, the
 * subscribe/unsubscribe business logic, shutdown teardown) stays entirely
 * with the caller, unchanged from before this helper existed.
 *
 * Logging is warn-once-per-outage, scoped per duplicate instance via a
 * closed-over `outageWarned` boolean: further errors during the SAME outage
 * only `debug`-log, so a flapping connection cannot flood stdout with one
 * warn per node-redis retry. A consequence worth knowing: the recovery warn
 * is gated on `outageWarned`, so the initial, error-free `ready` is silent.
 */
export function duplicateWithErrorHandler<T extends DuplicatableRedisClient>(client: T, label: string): T {
  const duplicate = client.duplicate();
  let outageWarned = false;

  duplicate.on('error', (err: Error) => {
    if (!outageWarned) {
      outageWarned = true;
      console.warn(`[crowi:redis] ${label} lost connection:`, err.message);
    } else {
      debug('%s retry error: %s', label, err.message);
    }
  });

  duplicate.on('ready', () => {
    if (outageWarned) {
      outageWarned = false;
      console.warn(`[crowi:redis] ${label} recovered`);
    }
  });

  return duplicate;
}
