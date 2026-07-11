/**
 * Hot-reload tests for `@crowi/plugin-storage-aws-s3`. The driver
 * implementation lives in the package; we test from here because the
 * package is a leaf workspace with no jest setup of its own (matches
 * `storage-local.test.ts` under this same dir).
 *
 * S3 SDK calls are mocked at the module boundary so we can observe
 * which client + bucket each driver method actually used, without
 * touching AWS.
 */
import type { PluginContext, StorageDriver } from '@crowi/plugin-api';
import { makeSharedPluginState } from './state-cell-test-support';

const sentSpies = {
  put: jest.fn(),
  get: jest.fn(),
  delete: jest.fn(),
};

let constructedClients: Array<{ region?: string }> = [];
let constructedInstances: Array<{ destroy: jest.Mock }> = [];

jest.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    public readonly tag = Symbol('s3-client');
    public readonly destroy = jest.fn();
    constructor(public readonly cfg: { region?: string }) {
      constructedClients.push({ region: cfg.region });
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
