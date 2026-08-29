/**
 * Hot-reload tests for `@crowi/plugin-storage-aws-s3`. The driver
 * implementation lives in the package; we test from here because the
 * package is a leaf workspace with no jest setup of its own (matches
 * `storage-local.test.ts` under this same dir).
 *
 * S3 SDK calls are mocked at the module boundary so we can observe
 * which client + bucket each driver method actually used, without
 * touching AWS.
 *
 * `beforeEach` calls `jest.resetModules()` so each test gets a fresh
 * module registry (hot-reload isolation); the SUT, the S3 SDK mock, and
 * `node:stream` are all re-`require()`'d inline per test/factory instead
 * of statically imported, since a static import is resolved once and
 * would keep pointing at a stale, pre-reset module instance. Each site
 * below carries an `eslint-disable-next-line` for
 * `@typescript-eslint/no-require-imports` for this reason.
 */
import type { PluginConfigVerificationSnapshot, PluginContext, StorageDriver } from '@crowi/plugin-api';
import { makeSharedPluginState } from './state-cell-test-support';

const sentSpies = {
  put: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

let constructedClients: Array<{ region?: string; maxAttempts?: number }> = [];
let constructedInstances: Array<{ destroy: jest.Mock }> = [];

jest.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    public readonly tag = Symbol('s3-client');
    public readonly destroy = jest.fn();
    constructor(public readonly cfg: { region?: string; maxAttempts?: number }) {
      constructedClients.push({ region: cfg.region, maxAttempts: cfg.maxAttempts });
      constructedInstances.push(this);
    }
    async send(command: any) {
      const kind = command.__kind;
      if (kind === 'put') {
        sentSpies.put({ ...command.input, clientTag: this.tag });
        return {};
      }
      if (kind === 'get') {
        sentSpies.get({ ...command.input, clientTag: this.tag });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Readable } = require('node:stream');
        return { Body: Readable.from([Buffer.from('payload')]) };
      }
      if (kind === 'delete') {
        sentSpies.delete({ ...command.input, clientTag: this.tag });
        return {};
      }
      throw new Error(`unexpected command ${String(kind)}`);
    }
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: class {
      __kind = 'put';
      constructor(public input: any) {}
    },
    GetObjectCommand: class {
      __kind = 'get';
      constructor(public input: any) {}
    },
    DeleteObjectCommand: class {
      __kind = 'delete';
      constructor(public input: any) {}
    },
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, command) => `signed://${command.input.Bucket}/${command.input.Key}`),
}));

const sharedPluginState = makeSharedPluginState();

/** Drains the entire microtask queue via a macrotask boundary — robust against a promise chain of unknown/changing depth, unlike counting `await Promise.resolve()` hops. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeCtx(own: { bucket: string }, aws: { region?: string; accessKeyId?: string; secretAccessKey?: string }): PluginContext {
  return {
    config: () => own as any,
    dependencyConfig: () => aws as any,
    setConfig: jest.fn(),
    pageMetadata: { get: jest.fn(), set: jest.fn(), remove: jest.fn() } as any,
    model: () => ({}),
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    state: sharedPluginState.state,
  };
}

describe('@crowi/plugin-storage-aws-s3 hot-reload', () => {
  let plugin: typeof import('@crowi/plugin-storage-aws-s3').default;
  let registeredDriver: StorageDriver | null = null;

  beforeEach(() => {
    jest.resetModules();
    sentSpies.put.mockClear();
    sentSpies.get.mockClear();
    sentSpies.delete.mockClear();
    constructedClients = [];
    constructedInstances = [];
    sharedPluginState.reset();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    plugin = require('@crowi/plugin-storage-aws-s3').default;
    registeredDriver = null;
  });

  function register(ctx: PluginContext): StorageDriver {
    const fakeRegistry = {
      register: (_name: string, driver: StorageDriver) => {
        registeredDriver = driver;
      },
    } as any;
    plugin.registerStorage!(fakeRegistry, ctx);
    if (!registeredDriver) throw new Error('registerStorage did not register a driver');
    return registeredDriver;
  }

  it('put uses the bucket configured at registerStorage', async () => {
    const ctx = makeCtx({ bucket: 'initial-bucket' }, { region: 'us-east-1' });
    const driver = register(ctx);
    await driver.put('k', Buffer.from('x'), { contentType: 'text/plain' });
    expect(sentSpies.put).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'initial-bucket', Key: 'k' }));
  });

  it('reconfigure swaps bucket; subsequent put uses the new bucket', async () => {
    const driver = register(makeCtx({ bucket: 'old' }, { region: 'us-east-1' }));
    await plugin.reconfigure!(makeCtx({ bucket: 'new' }, { region: 'us-east-1' }));
    await driver.put('k', Buffer.from('x'), { contentType: 'text/plain' });
    expect(sentSpies.put).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'new' }));
  });

  it('reconfigure rebuilds the S3Client with the new region', async () => {
    register(makeCtx({ bucket: 'b' }, { region: 'us-east-1' }));
    const beforeCount = constructedClients.length;
    await plugin.reconfigure!(makeCtx({ bucket: 'b' }, { region: 'ap-northeast-1' }));
    const after = constructedClients.slice(beforeCount);
    // At least one fresh client built for the new region.
    expect(after.some((c) => c.region === 'ap-northeast-1')).toBe(true);
  });

  it('throws on put when bucket is not configured', async () => {
    const driver = register(makeCtx({ bucket: '' }, { region: 'us-east-1' }));
    await expect(driver.put('k', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/bucket is not configured/);
  });

  it('inflight put snapshots state at call time so a concurrent reconfigure cannot mid-swap', async () => {
    const driver = register(makeCtx({ bucket: 'old' }, { region: 'us-east-1' }));

    // Park the SDK send so the put is in-flight at the moment of
    // reconfigure. The snapshot semantics of the driver method mean
    // it must use bucket='old' for this command even though the state
    // is mutated to 'new' before the send resolves.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    let releaseSend: ((v: unknown) => void) | undefined;
    const releasePromise = new Promise<unknown>((r) => {
      releaseSend = r;
    });
    sdk.S3Client.prototype.send = jest.fn(async function (this: any, command: any) {
      // Record the bucket at send-time, then block.
      sentSpies.put({ ...command.input, clientTag: this.tag });
      await releasePromise;
      return {};
    });

    const inflight = driver.put('k1', Buffer.from('a'), { contentType: 'text/plain' });
    // Hand control to the put so it reaches the parked send.
    await Promise.resolve();
    await Promise.resolve();
    // While the send is parked, reconfigure swaps state to bucket='new'.
    await plugin.reconfigure!(makeCtx({ bucket: 'new' }, { region: 'us-east-1' }));

    releaseSend?.(undefined);
    await inflight;

    expect(sentSpies.put).toHaveBeenCalledTimes(1);
    expect(sentSpies.put).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'old' }));
  });

  it('reconfigure disposes the previous S3Client (destroy()) only once an in-flight put against it settles (AC-3/AC-5)', async () => {
    const driver = register(makeCtx({ bucket: 'old' }, { region: 'us-east-1' }));
    const oldClient = constructedInstances.at(-1);
    if (!oldClient) throw new Error('expected registerStorage to have constructed an S3Client');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    let releaseSend: ((v: unknown) => void) | undefined;
    const releasePromise = new Promise<unknown>((r) => {
      releaseSend = r;
    });
    sdk.S3Client.prototype.send = jest.fn(async function (this: any, command: any) {
      sentSpies.put({ ...command.input, clientTag: this.tag });
      await releasePromise;
      return {};
    });

    const inflight = driver.put('k1', Buffer.from('a'), { contentType: 'text/plain' });
    await Promise.resolve();
    await Promise.resolve();

    await plugin.reconfigure!(makeCtx({ bucket: 'new' }, { region: 'us-east-1' }));
    // The in-flight put against `oldClient` hasn't settled yet — dispose (destroy()) must wait.
    expect(oldClient.destroy).not.toHaveBeenCalled();

    releaseSend?.(undefined);
    await inflight;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('@crowi/plugin-storage-aws-s3 verifyConfig (feature-plugin-config-live-verification, AC-5)', () => {
  let plugin: typeof import('@crowi/plugin-storage-aws-s3').default;

  beforeEach(() => {
    jest.resetModules();
    sentSpies.put.mockClear();
    sentSpies.get.mockClear();
    sentSpies.delete.mockClear();
    constructedClients = [];
    constructedInstances = [];
    sharedPluginState.reset();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    plugin = require('@crowi/plugin-storage-aws-s3').default;
  });

  function makeSnapshot(own: { bucket: string }, aws: { region?: string; accessKeyId?: string; secretAccessKey?: string }): PluginConfigVerificationSnapshot {
    return {
      config: () => own as any,
      dependencyConfig: () => aws as any,
    };
  }

  /**
   * The module-level mock's `get` always answers with a fixed payload —
   * fine for the hot-reload tests above (they never inspect bytes), but
   * `verifyConfig`'s own round trip compares what it reads back against
   * what it wrote. Installs a `send` that actually stores/echoes/forgets
   * per key, like a real bucket would.
   */
  function installRoundTripSend(): void {
    const store = new Map<string, Buffer>();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    sdk.S3Client.prototype.send = jest.fn(async function (this: any, command: any) {
      const kind = command.__kind;
      if (kind === 'put') {
        sentSpies.put({ ...command.input, clientTag: this.tag });
        const body = command.input.Body;
        store.set(command.input.Key, Buffer.isBuffer(body) ? body : Buffer.from(body));
        return {};
      }
      if (kind === 'get') {
        sentSpies.get({ ...command.input, clientTag: this.tag });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Readable } = require('node:stream');
        return { Body: Readable.from([store.get(command.input.Key) ?? Buffer.alloc(0)]) };
      }
      if (kind === 'delete') {
        sentSpies.delete({ ...command.input, clientTag: this.tag });
        store.delete(command.input.Key);
        return {};
      }
      throw new Error(`unexpected command ${String(kind)}`);
    });
  }

  it('AC-5: round-trips through StorageDriver.put/get/delete using the snapshot AWS dependency, a single-attempt client, and destroys it when done', async () => {
    installRoundTripSend();
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2', accessKeyId: 'AKIA', secretAccessKey: 'secret' });

    const result = await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    expect(result).toEqual({ status: 'ok' });
    expect(sentSpies.put).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'verify-bucket' }));
    expect(sentSpies.get).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'verify-bucket' }));
    expect(sentSpies.delete).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'verify-bucket' }));

    const putCallArg = sentSpies.put.mock.calls.at(-1)?.[0];
    expect(String(putCallArg?.Key ?? '')).not.toMatch(/^attachment\//);

    // Snapshot AWS dependency (region/credentials) fed the client, with a
    // single-attempt policy — never the real hot-reload cell's client.
    expect(constructedClients.at(-1)).toMatchObject({ region: 'us-west-2', maxAttempts: 1 });

    // `destroy()` is chained off the cleanup delete's settlement (not
    // called eagerly the instant `verdict` is known — see the call site's
    // doc), so it lands a handful of microtasks after `verifyConfig`
    // itself has already resolved. A macrotask boundary reliably drains
    // the whole microtask queue first (unlike counting `Promise.resolve()`
    // hops, which is brittle against the exact chain depth).
    await flushMicrotasks();
    expect(constructedInstances.at(-1)?.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys its one-shot client even when the round trip fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    sdk.S3Client.prototype.send = jest.fn(async () => {
      throw Object.assign(new Error('nope'), { name: 'AccessDenied' });
    });
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2' });

    const result = await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    expect(result).toEqual({ status: 'failed', reason: 'auth-failed' });
    await flushMicrotasks();
    expect(constructedInstances.at(-1)?.destroy).toHaveBeenCalledTimes(1);
  });

  it('a put success followed by a get AccessDenied is reported as write-denied, not auth-failed (the put-succeeded-but-cannot-read row)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    sdk.S3Client.prototype.send = jest.fn(async function (this: any, command: any) {
      if (command.__kind === 'put') return {};
      if (command.__kind === 'get') throw Object.assign(new Error('nope'), { name: 'AccessDenied' });
      return {};
    });
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2' });

    const result = await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    expect(result).toEqual({ status: 'failed', reason: 'write-denied' });
  });

  it('a put() that reports storing under a different key than requested is reported as unknown, even though the payload round-trips correctly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { probeS3RoundTrip } = require('@crowi/plugin-storage-aws-s3') as typeof import('@crowi/plugin-storage-aws-s3');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Readable } = require('node:stream');
    let written: Buffer | undefined;
    const putSpy = jest.fn(async (_key: string, body: unknown) => {
      written = body as Buffer;
      return { key: 'some-other-key' };
    });
    const getSpy = jest.fn(async () => Readable.from([written as Buffer]));
    const deleteSpy = jest.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = { client: new (require('@aws-sdk/client-s3').S3Client)({ region: 'us-west-2' }), bucket: 'verify-bucket' };

    const { verdict, cleanupSettled } = await probeS3RoundTrip(state, 5_000, { put: putSpy, get: getSpy, delete: deleteSpy });

    await expect(verdict).resolves.toEqual({ status: 'failed', reason: 'unknown' });
    await cleanupSettled;
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('the independent cleanup delete is still attempted after a successful put, even when the following get() rejects', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    sdk.S3Client.prototype.send = jest.fn(async (command: any) => {
      if (command.__kind === 'put') return {};
      if (command.__kind === 'get') throw new Error('boom');
      if (command.__kind === 'delete') {
        sentSpies.delete({ ...command.input });
        return {};
      }
      return {};
    });
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2' });

    await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    expect(sentSpies.delete).toHaveBeenCalledTimes(1);
  });

  it('AC-11: a rejecting cleanup delete does not alter a successful verdict, and destroy() still proceeds once cleanup settles', async () => {
    installRoundTripSend();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const realSend = sdk.S3Client.prototype.send;
    sdk.S3Client.prototype.send = jest.fn(async function (this: any, command: any) {
      if (command.__kind === 'delete') {
        sentSpies.delete({ ...command.input });
        throw Object.assign(new Error('cleanup delete failed'), { name: 'AccessDenied' });
      }
      return realSend.call(this, command);
    });
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2', accessKeyId: 'AKIA', secretAccessKey: 'secret' });

    const result = await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    // The rejecting cleanup delete must not downgrade an already-successful
    // put/get round trip.
    expect(result).toEqual({ status: 'ok' });
    expect(sentSpies.delete).toHaveBeenCalledTimes(1);
    // `destroy()` is chained off `cleanupSettled`, which resolves once the
    // (rejecting) delete attempt itself settles, not once it succeeds.
    await flushMicrotasks();
    expect(constructedInstances.at(-1)?.destroy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('AC-11: a rejecting cleanup delete does not alter an already-failed verdict', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sdk.S3Client.prototype.send = jest.fn(async (command: any) => {
      if (command.__kind === 'put') return {};
      if (command.__kind === 'get') throw Object.assign(new Error('object not found'), { name: 'NoSuchKey' });
      if (command.__kind === 'delete') {
        sentSpies.delete({ ...command.input });
        throw new Error('cleanup delete failed too');
      }
      return {};
    });
    const snapshot = makeSnapshot({ bucket: 'verify-bucket' }, { region: 'us-west-2' });

    const result = await plugin.verifyConfig!(snapshot, { timeoutMs: 10_000 });

    // `get()`'s own failure decides the verdict (`NoSuchKey` isn't in the
    // classification table, so `unknown`) — the ALSO-rejecting cleanup
    // delete must not override it with a different reason.
    expect(result).toEqual({ status: 'failed', reason: 'unknown' });
    expect(sentSpies.delete).toHaveBeenCalledTimes(1);
    // The rejecting delete's own `.then(_, () => console.warn(...))`
    // handler settles a few microtask hops after `verdict` itself (an
    // extra `await` inside `driver.delete`'s `cell.withValue` wrapper) —
    // flush before restoring the spy so that `console.warn` call doesn't
    // leak into whichever test runs next.
    await flushMicrotasks();
    warnSpy.mockRestore();
  });

  it('AC-11: cleanup delete fires within its own budget even when get() is still gated well past it — destroy() is not blocked on get() settling either', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@aws-sdk/client-s3');
    let releaseGet: (() => void) | undefined;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    sdk.S3Client.prototype.send = jest.fn(async (command: any) => {
      if (command.__kind === 'put') return {};
      if (command.__kind === 'get') {
        // Simulates a `get()` far slower than the caller (the manager's
        // 10s hook race) would ever wait for — but not aborted (§3): the
        // underlying probe keeps running and eventually settles.
        await getGate;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Readable } = require('node:stream');
        return { Body: Readable.from([Buffer.from('irrelevant-by-then')]) };
      }
      if (command.__kind === 'delete') {
        sentSpies.delete({ ...command.input });
        return {};
      }
      return {};
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { probeS3RoundTrip } = require('@crowi/plugin-storage-aws-s3') as typeof import('@crowi/plugin-storage-aws-s3');
    // A short cleanup budget so the test doesn't need a real multi-second
    // wait — production callers always use the real 5s default.
    const state = { client: new sdk.S3Client({ region: 'us-west-2', maxAttempts: 1 }), bucket: 'verify-bucket' };
    const { verdict, cleanupSettled } = await probeS3RoundTrip(state, 30);
    // `probeS3RoundTrip` itself never calls `destroy()` — only `verifyConfig`
    // does, chained off `cleanupSettled` (see its call site's doc). Mirror
    // that one line here so this test actually exercises the claim in its
    // name, rather than only inferring it from `cleanupSettled` resolving.
    void cleanupSettled.finally(() => state.client.destroy());

    // `get()` is still gated (never released yet) when the cleanup budget
    // elapses — delete must fire anyway, and `cleanupSettled` (which
    // `verifyConfig` chains `destroy()` off) must resolve once it does.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sentSpies.delete).toHaveBeenCalledTimes(1);
    await cleanupSettled;
    expect(state.client.destroy).toHaveBeenCalledTimes(1);

    releaseGet?.();
    await verdict;
  });
});

describe('classifyS3Error (feature-plugin-config-live-verification AC-12)', () => {
  // Resolved via `require` (not a top-level `import`) to match this file's
  // established pattern for the SUT — `classifyS3Error` is pure (doesn't
  // touch the mocked SDK at call time), so which module instance it comes
  // from doesn't matter, only consistency with the rest of the file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { classifyS3Error } = require('@crowi/plugin-storage-aws-s3') as typeof import('@crowi/plugin-storage-aws-s3');
  const classify = classifyS3Error;

  it('NoSuchBucket -> resource-missing', () => {
    expect(classify({ name: 'NoSuchBucket' }, { afterSuccessfulPut: false })).toBe('resource-missing');
  });

  it('AccessDenied before a successful put -> auth-failed', () => {
    expect(classify({ name: 'AccessDenied' }, { afterSuccessfulPut: false })).toBe('auth-failed');
  });

  it('AccessDenied after a successful put -> write-denied', () => {
    expect(classify({ name: 'AccessDenied' }, { afterSuccessfulPut: true })).toBe('write-denied');
  });

  it.each(['InvalidAccessKeyId', 'SignatureDoesNotMatch'])('%s -> auth-failed', (name) => {
    expect(classify({ name }, { afterSuccessfulPut: false })).toBe('auth-failed');
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'])('a direct .code of %s -> unreachable', (code) => {
    expect(classify(Object.assign(new Error('x'), { code }), { afterSuccessfulPut: false })).toBe('unreachable');
  });

  it('a connection error nested under .cause.code -> unreachable', () => {
    const err = Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('inner'), { code: 'ECONNREFUSED' }) });
    expect(classify(err, { afterSuccessfulPut: false })).toBe('unreachable');
  });

  it('anything not in the table -> unknown', () => {
    expect(classify(new Error('mystery'), { afterSuccessfulPut: false })).toBe('unknown');
    expect(classify({ name: 'SomeOtherError' }, { afterSuccessfulPut: false })).toBe('unknown');
  });
});
