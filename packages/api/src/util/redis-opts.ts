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
    ...credentials,
  };
}
