import Crowi from 'src/crowi';
import { RedisClientType } from 'redis';
import { resolveRedisKeyspace, type RedisKeyspace } from 'src/util/redis-keyspace';

export default class LRU {
  crowi: Crowi;

  max: number;

  client: any;

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

  async add(namespace, key) {
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
