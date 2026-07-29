import type Crowi from 'src/crowi';
import { resolveRedisKeyspace } from 'src/util/redis-keyspace';
import LRU from './lru';

/**
 * Unit tests for the recently-viewed-pages LRU service
 * (feature-redis-key-prefix §1/§2 — first dedicated fake-client coverage;
 * previously this was only exercised via `lru.smoke.test.ts` against a real
 * Redis instance).
 *
 * A minimal fake node-redis v4 client: `multi()` returns a chainable
 * recorder so `add()`'s pipelined `ZREMRANGEBYRANK` + `ZADD` can be
 * asserted without a live Redis connection.
 */
interface FakeRedisState {
  calls: string[];
}

function makeFakeRedis(): { client: unknown; state: FakeRedisState } {
  const state: FakeRedisState = { calls: [] };
  const multiChain = {
    ZREMRANGEBYRANK(key: string, min: number, max: number) {
      state.calls.push(`ZREMRANGEBYRANK ${key} ${min} ${max}`);
      return multiChain;
    },
    ZADD(key: string, entry: { score: number; value: string }) {
      state.calls.push(`ZADD ${key} ${entry.value}`);
      return multiChain;
    },
    async exec() {
      return state.calls.slice();
    },
  };
  const client = {
    multi() {
      return multiChain;
    },
    async ZREMRANGEBYRANK(key: string, min: number, max: number) {
      state.calls.push(`ZREMRANGEBYRANK ${key} ${min} ${max}`);
    },
    async ZRANGE(key: string, min: number, max: number, opts: unknown) {
      state.calls.push(`ZRANGE ${key} ${min} ${max} ${JSON.stringify(opts)}`);
      return [];
    },
  };
  return { client, state };
}

const fakeCrowi = (client: unknown, instanceSlug: string): Crowi =>
  ({
    redis: client,
    getBaseUrl: () => null,
    getEnv: () => ({ REDIS_KEY_PREFIX: instanceSlug }) as unknown as NodeJS.ProcessEnv,
  }) as unknown as Crowi;

describe('LRU', () => {
  describe('no Redis configured (fail-open)', () => {
    it('every method is a silent no-op when crowi.redis is null', async () => {
      const lru = new LRU({ redis: null } as unknown as Crowi);
      expect(lru.max).toBe(10);
      await expect(lru.add('ns', 'page')).resolves.toBeUndefined();
      await expect(lru.range('ns')).resolves.toBeUndefined();
      await expect(lru.removeByRange('ns', -1)).resolves.toBeUndefined();
      expect(lru.get('ns', 5)).toBeUndefined();
    });
  });

  describe('instance keyspace (feature-redis-key-prefix §1/§2)', () => {
    it('add() pipelines ZREMRANGEBYRANK+ZADD against the instance-scoped key, not the bare namespace', async () => {
      const { client, state } = makeFakeRedis();
      const lru = new LRU(fakeCrowi(client, 'krswd'));

      await lru.add('user-1', 'page-1');

      expect(state.calls).toEqual(['ZREMRANGEBYRANK crowi:krswd:lru:user-1 0 -11', 'ZADD crowi:krswd:lru:user-1 page-1']);
    });

    it('range() reads the instance-scoped key', async () => {
      const { client, state } = makeFakeRedis();
      const lru = new LRU(fakeCrowi(client, 'krswd'));

      await lru.range('user-1', 5);

      expect(state.calls).toEqual(['ZRANGE crowi:krswd:lru:user-1 0 4 {"REV":true}']);
    });

    it('removeByRange() targets the instance-scoped key', async () => {
      const { client, state } = makeFakeRedis();
      const lru = new LRU(fakeCrowi(client, 'krswd'));

      await lru.removeByRange('user-1', -2);

      expect(state.calls).toEqual(['ZREMRANGEBYRANK crowi:krswd:lru:user-1 0 -2']);
    });

    it('two distinct instance slugs sharing the same Redis do not share a namespace', async () => {
      const { client, state } = makeFakeRedis();
      const lruA = new LRU(fakeCrowi(client, 'instance-a'));
      const lruB = new LRU(fakeCrowi(client, 'instance-b'));

      await lruA.add('user-1', 'page-1');
      await lruB.add('user-1', 'page-1');

      expect(state.calls).toEqual([
        'ZREMRANGEBYRANK crowi:instance-a:lru:user-1 0 -11',
        'ZADD crowi:instance-a:lru:user-1 page-1',
        'ZREMRANGEBYRANK crowi:instance-b:lru:user-1 0 -11',
        'ZADD crowi:instance-b:lru:user-1 page-1',
      ]);
    });

    it('matches the key resolveRedisKeyspace() itself computes', async () => {
      const { client, state } = makeFakeRedis();
      const crowiLike = fakeCrowi(client, 'krswd');
      const lru = new LRU(crowiLike);
      const expectedKey = resolveRedisKeyspace(crowiLike).key('lru', 'user-1');

      await lru.range('user-1', 1);

      expect(state.calls[0]).toContain(expectedKey);
    });
  });

  describe('get()', () => {
    it('delegates to range() when a client is configured', async () => {
      const { client, state } = makeFakeRedis();
      const lru = new LRU(fakeCrowi(client, 'krswd'));

      lru.get('user-1', 3);
      // `get()` is synchronous and returns range()'s promise without
      // awaiting — flush a tick so the fake client's call lands.
      await Promise.resolve();

      expect(state.calls).toEqual(['ZRANGE crowi:krswd:lru:user-1 0 2 {"REV":true}']);
    });

    it('returns undefined when no client is configured', () => {
      const lru = new LRU({ redis: null } as unknown as Crowi);
      expect(lru.get('user-1', 3)).toBeUndefined();
    });
  });
});
