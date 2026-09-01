import type { RedisClientType } from 'redis';
import Crowi from 'src/crowi';
import { type RedisKeyspace, resolveRedisKeyspace } from 'src/util/redis-keyspace';

export default class LRU {
  crowi: Crowi;

  max: number;

  /**
   * `crowi.redis` is typed `any` on `Crowi` itself (untyped boot field), so
   * this annotation exists to pin `RedisClientType` against the commands
   * actually called below (`ZREMRANGEBYRANK` / `ZADD` / `ZRANGE` /
   * `multi()`) — a type-check failure here is the signal that the installed
   * client's types no longer match one of them.
   */
  client: RedisClientType | null;

  /**
   * Resolved instance keyspace (feature-redis-key-prefix §1/§2), non-null
   * exactly when `client` is (both set together in the constructor below).
   * `resolveRedisKeyspace` — not the `-IfEnabled` variant — is appropriate
   * here: it only runs once `crowi.redis` is confirmed set, at which point
   * env validation already guarantees a keyspace is resolvable, so there is
   * no legitimate "Redis enabled but no keyspace" case to degrade for.
   */
  private keyspace: RedisKeyspace | null;

  constructor(crowi: Crowi) {
    this.crowi = crowi;
    this.max = 10;
    this.client = null;
    this.keyspace = null;

    if (this.crowi && this.crowi.redis) {
      this.client = this.crowi.redis;
      this.keyspace = resolveRedisKeyspace(this.crowi);
    }
  }

  /**
   * Per-namespace sorted-set key, instance-scoped
   * (`crowi:<instance-slug>:lru:<namespace>`) so multiple Crowi instances
   * sharing one Redis do not cross-talk on recently-viewed-page lists.
   */
  private keyFor(namespace: string): string {
    return this.keyspace!.key('lru', namespace);
  }

  async removeByRange(namespace, max) {
    const { client } = this;

    if (client) {
      return await client.ZREMRANGEBYRANK(this.keyFor(namespace), 0, max);
    }
  }

  // Explicit return type: `multi().exec()`'s inferred result type is built
  // from internal @redis/client generics that TS can't name in a
  // `declaration: true` build (TS2742) — the caller only ever `.catch()`s
  // this promise (see `hono/handlers/page.ts`), so the exact tuple shape
  // carries no information anyone reads.
  async add(namespace: string, key: string): Promise<unknown> {
    const { client } = this;

    if (client) {
      const zsetKey = this.keyFor(namespace);
      // ZREMRANGEBYRANK + ZADD share no read dependency, so pipeline
      // them into a single round-trip. Halves Redis latency on the
      // page-view hot path.
      return await client
        .multi()
        .ZREMRANGEBYRANK(zsetKey, 0, -this.max - 1)
        .ZADD(zsetKey, { score: Date.now(), value: key })
        .exec();
    }
  }

  async range(namespace, limit = 0) {
    const { client } = this;

    if (client) {
      return await client.ZRANGE(this.keyFor(namespace), 0, limit - 1, { REV: true });
    }
  }

  get(namespace, limit) {
    if (this.client) {
      return this.range(namespace, limit);
    }
  }
}
