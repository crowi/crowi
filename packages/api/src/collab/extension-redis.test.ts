/**
 * Unit coverage for `buildCollabRedisExtension`. The function is the
 * Phase 9 seam that decides whether `@hocuspocus/extension-redis` gets
 * attached to the collab engine. We exercise both branches:
 *   - `crowi.redis === null` → no extension (single-instance dev)
 *   - `crowi.redis` populated → extension constructed with the
 *     expected `prefix` / `identifier` / `createClient` shape
 *
 * We mock both `@hocuspocus/extension-redis` and `ioredis` so the test
 * doesn't open real sockets and so we can capture the Configuration
 * the extension was built with. The extension's *internal* pub/sub
 * behaviour is upstream-tested; here we only verify the wiring
 * choices the api made.
 */

interface CapturedExtensionConfig {
  identifier?: string;
  prefix?: string;
  createClient?: () => unknown;
}

let lastExtensionConfig: CapturedExtensionConfig | null = null;
let lastCreateClientResult: unknown = null;
let ioredisConstructorCalls: Array<Record<string, unknown>> = [];

jest.mock('@hocuspocus/extension-redis', () => ({
  Redis: jest.fn(function (this: Record<string, unknown>, config: CapturedExtensionConfig) {
    lastExtensionConfig = config;
    this.configuration = config;
    return this;
  }),
}));

jest.mock('ioredis', () => {
  function FakeIoRedis(this: Record<string, unknown>, opts: Record<string, unknown>) {
    ioredisConstructorCalls.push(opts);
    this.options = opts;
    this.disconnect = jest.fn();
    return this;
  }
  return {
    __esModule: true,
    default: FakeIoRedis,
  };
});

import type Crowi from 'src/crowi';
import { buildCollabRedisExtension, parseRedisUrlForIoredis } from './extension-redis';

beforeEach(() => {
  lastExtensionConfig = null;
  lastCreateClientResult = null;
  ioredisConstructorCalls = [];
});

/**
 * Build the smallest fixture that `buildCollabRedisExtension` reads
 * from a `Crowi`. Casting through `unknown` is the established pattern
 * in api unit tests for narrow Crowi-shaped fixtures.
 *
 * `getBaseUrl` / `getEnv` back `resolveRedisKeyspace()`
 * (feature-redis-key-prefix §1/§2 — the extension's `prefix` is now
 * instance-scoped instead of the literal `crowi:collab`); `clientUrl`
 * defaults to a fixed origin so every pre-existing call site (which only
 * ever passed `redis`/`redisUrl`) keeps resolving the same deterministic
 * slug without having to be updated individually.
 */
function fakeCrowi(redis: unknown, redisUrl: string | null, clientUrl: string | null = 'https://wiki.example.com'): Crowi {
  return { redis, redisUrl, getBaseUrl: () => clientUrl, getEnv: () => ({}) as NodeJS.ProcessEnv } as unknown as Crowi;
}

describe('buildCollabRedisExtension', () => {
  it('returns null when crowi.redis is null (single-instance dev)', () => {
    const ext = buildCollabRedisExtension(fakeCrowi(null, 'redis://localhost:6379'));
    expect(ext).toBeNull();
    // Extension constructor should not have been touched.
    expect(lastExtensionConfig).toBeNull();
  });

  it('returns null when crowi.redis is set but redisUrl is missing (defensive)', () => {
    const fakeClient = { connected: true };
    const ext = buildCollabRedisExtension(fakeCrowi(fakeClient, null));
    expect(ext).toBeNull();
    expect(lastExtensionConfig).toBeNull();
  });

  it('builds the extension with the instance-scoped prefix (feature-redis-key-prefix §1/§2) and identifier derived from HOSTNAME or pid', () => {
    const fakeClient = { connected: true };
    const ext = buildCollabRedisExtension(fakeCrowi(fakeClient, 'redis://localhost:6379'));
    expect(ext).not.toBeNull();
    expect(lastExtensionConfig).not.toBeNull();
    expect(lastExtensionConfig?.prefix).toBe('crowi:wiki.example.com:collab');
    // identifier must be present and non-empty regardless of HOSTNAME
    // being set — pid fallback keeps single-host multi-process dev
    // working too.
    expect(typeof lastExtensionConfig?.identifier).toBe('string');
    expect((lastExtensionConfig?.identifier ?? '').length).toBeGreaterThan(0);
  });

  it('an explicit REDIS_KEY_PREFIX overrides the CLIENT_URL-derived slug in the prefix', () => {
    const fakeClient = { connected: true };
    const crowi = {
      redis: fakeClient,
      redisUrl: 'redis://localhost:6379',
      getBaseUrl: () => 'https://wiki.example.com',
      getEnv: () => ({ REDIS_KEY_PREFIX: 'krswd' }) as unknown as NodeJS.ProcessEnv,
    } as unknown as Crowi;
    buildCollabRedisExtension(crowi);
    expect(lastExtensionConfig?.prefix).toBe('crowi:krswd:collab');
  });

  it('two instances with distinct CLIENT_URLs get distinct prefixes (no cross-instance collab collision)', () => {
    buildCollabRedisExtension(fakeCrowi({ connected: true }, 'redis://localhost:6379', 'https://wiki.krswd.family'));
    expect(lastExtensionConfig?.prefix).toBe('crowi:wiki.krswd.family:collab');
  });

  it('includes HOSTNAME and pid in identifier so bare-metal multi-process setups dedupe correctly', () => {
    const original = process.env.HOSTNAME;
    process.env.HOSTNAME = 'crowi-pod-test-123';
    try {
      buildCollabRedisExtension(fakeCrowi({ connected: true }, 'redis://localhost:6379'));
      // Shape `<hostname>-<pid>` — `HOSTNAME` is the docker / k8s
      // container identifier; pid guards against the same host
      // running multiple api workers under systemd / pm2 etc.
      expect(lastExtensionConfig?.identifier).toBe(`crowi-pod-test-123-${process.pid}`);
    } finally {
      if (original === undefined) {
        delete process.env.HOSTNAME;
      } else {
        process.env.HOSTNAME = original;
      }
    }
  });

  it('createClient callback builds an ioredis client from the redis URL with host/port', () => {
    buildCollabRedisExtension(fakeCrowi({ connected: true }, 'redis://example.internal:6390'));
    expect(typeof lastExtensionConfig?.createClient).toBe('function');
    lastCreateClientResult = lastExtensionConfig?.createClient?.();
    expect(lastCreateClientResult).not.toBeNull();
    expect(ioredisConstructorCalls).toHaveLength(1);
    expect(ioredisConstructorCalls[0]).toMatchObject({ host: 'example.internal', port: 6390 });
  });

  it('createClient propagates password from URL auth segment', () => {
    buildCollabRedisExtension(fakeCrowi({ connected: true }, 'redis://default:s3cret@redis.example:6379'));
    lastExtensionConfig?.createClient?.();
    expect(ioredisConstructorCalls[0]).toMatchObject({ host: 'redis.example', port: 6379, password: 's3cret' });
  });

  it('createClient enables TLS with rejectUnauthorized for rediss:// URLs', () => {
    const original = process.env.REDIS_REJECT_UNAUTHORIZED;
    delete process.env.REDIS_REJECT_UNAUTHORIZED;
    try {
      buildCollabRedisExtension(fakeCrowi({ connected: true }, 'rediss://redis.example:6380'));
      lastExtensionConfig?.createClient?.();
      expect(ioredisConstructorCalls[0]).toMatchObject({
        host: 'redis.example',
        port: 6380,
        tls: { rejectUnauthorized: true },
      });
    } finally {
      if (original !== undefined) process.env.REDIS_REJECT_UNAUTHORIZED = original;
    }
  });

  it('createClient honours REDIS_REJECT_UNAUTHORIZED=0 for rediss:// URLs', () => {
    const original = process.env.REDIS_REJECT_UNAUTHORIZED;
    process.env.REDIS_REJECT_UNAUTHORIZED = '0';
    try {
      buildCollabRedisExtension(fakeCrowi({ connected: true }, 'rediss://redis.example:6380'));
      lastExtensionConfig?.createClient?.();
      expect(ioredisConstructorCalls[0]).toMatchObject({
        tls: { rejectUnauthorized: false },
      });
    } finally {
      if (original === undefined) {
        delete process.env.REDIS_REJECT_UNAUTHORIZED;
      } else {
        process.env.REDIS_REJECT_UNAUTHORIZED = original;
      }
    }
  });

  it('createClient carries the REDIS_URL database pathname (feature-redis-key-prefix §3) into ioredis db', () => {
    buildCollabRedisExtension(fakeCrowi({ connected: true }, 'redis://redis.example:6379/1'));
    lastExtensionConfig?.createClient?.();
    expect(ioredisConstructorCalls[0]).toMatchObject({ db: 1 });
  });
});

describe('parseRedisUrlForIoredis', () => {
  it('an absent pathname resolves db to 0, matching node-redis buildRedisOpts default', () => {
    expect(parseRedisUrlForIoredis('redis://localhost:6379')).toStrictEqual({ host: 'localhost', port: 6379, db: 0 });
  });

  it('"/0" and "/1" resolve db to the parsed integer', () => {
    expect(parseRedisUrlForIoredis('redis://localhost:6379/0')).toStrictEqual({ host: 'localhost', port: 6379, db: 0 });
    expect(parseRedisUrlForIoredis('redis://localhost:6379/1')).toStrictEqual({ host: 'localhost', port: 6379, db: 1 });
  });

  it('rediss:// with ACL userinfo + "/1" resolves credentials, tls, AND db together', () => {
    const original = process.env.REDIS_REJECT_UNAUTHORIZED;
    delete process.env.REDIS_REJECT_UNAUTHORIZED;
    try {
      expect(parseRedisUrlForIoredis('rediss://ACL-user:password@host/1')).toStrictEqual({
        host: 'host',
        port: 6379,
        db: 1,
        username: 'ACL-user',
        password: 'password',
        tls: { rejectUnauthorized: true },
      });
    } finally {
      if (original !== undefined) process.env.REDIS_REJECT_UNAUTHORIZED = original;
    }
  });

  it('an invalid database pathname throws instead of silently connecting to DB 0 — same error class buildRedisOpts throws for the same REDIS_URL', () => {
    expect(() => parseRedisUrlForIoredis('redis://localhost:6379/foo')).toThrow(/database pathname/);
    expect(() => parseRedisUrlForIoredis('redis://localhost:6379/-1')).toThrow(/database pathname/);
    expect(() => parseRedisUrlForIoredis('redis://localhost:6379/1/extra')).toThrow(/database pathname/);
  });
});
