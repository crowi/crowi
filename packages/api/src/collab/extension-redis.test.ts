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
import { buildCollabRedisExtension } from './extension-redis';

beforeEach(() => {
  lastExtensionConfig = null;
  lastCreateClientResult = null;
  ioredisConstructorCalls = [];
});

/**
 * Build the smallest fixture that `buildCollabRedisExtension` reads
 * from a `Crowi`. Casting through `unknown` is the established pattern
 * in api unit tests for narrow Crowi-shaped fixtures.
 */
function fakeCrowi(redis: unknown, redisUrl: string | null): Crowi {
  return { redis, redisUrl } as unknown as Crowi;
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

  it('builds the extension with prefix=crowi:collab and identifier derived from HOSTNAME or pid', () => {
    const fakeClient = { connected: true };
    const ext = buildCollabRedisExtension(fakeCrowi(fakeClient, 'redis://localhost:6379'));
    expect(ext).not.toBeNull();
    expect(lastExtensionConfig).not.toBeNull();
    expect(lastExtensionConfig?.prefix).toBe('crowi:collab');
    // identifier must be present and non-empty regardless of HOSTNAME
    // being set — pid fallback keeps single-host multi-process dev
    // working too.
    expect(typeof lastExtensionConfig?.identifier).toBe('string');
    expect((lastExtensionConfig?.identifier ?? '').length).toBeGreaterThan(0);
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
});
