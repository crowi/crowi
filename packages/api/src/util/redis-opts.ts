import url from 'node:url';

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
  const { hostname: host, port, auth, protocol } = url.parse(redisUrl);
  const password = auth ? { password: auth.split(':')[1] } : {};
  const portNumber = port ? parseInt(port, 10) : 6379;
  // node-redis v4 selects the TLS transport ONLY on the literal
  // `tls: true` (`options.tls === true` in @redis/client's socket.js), with
  // the tls.ConnectionOptions flattened into the same socket object
  // (`RedisTlsSocketOptions`). A nested `tls: {...}` object fails that
  // strict check and silently downgrades rediss:// to a plaintext socket.
  const tlsOpts = protocol === 'rediss:' ? { tls: true as const, requestCert: true, rejectUnauthorized } : null;
  return {
    socket: {
      host,
      port: portNumber,
      ...tlsOpts,
    },
    ...password,
  };
}
