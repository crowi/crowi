import { Types } from 'mongoose';
import type { EmbedInput, EmbedRenderer, PluginLogger, RenderContext, RenderResult } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { DEFAULT_FRESH_TTL_SEC, DEFAULT_STALE_MULTIPLIER, RENDER_ERROR_TTL, cachedRender, scopeForPlugin } from './index';
import { MongoCacheStorage } from './mongodb-cache';
import { createAuthContextStub } from '../registry';

const silentLog: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const buildStorage = (): MongoCacheStorage => {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  return new MongoCacheStorage({ PluginRenderCache, log: { warn: () => undefined, debug: () => undefined } });
};

const buildCtx = (storage: MongoCacheStorage, pluginName: string): RenderContext => ({
  mode: 'view',
  log: silentLog,
  actor: { kind: 'system' },
  cache: scopeForPlugin(storage, pluginName),
  auth: createAuthContextStub(),
});

const PLUGIN = '@crowi/plugin-test-swr';

const buildRenderer = (result: RenderResult | (() => RenderResult), cacheVersion = 1): EmbedRenderer & { calls: number } => {
  const stub = {
    cacheVersion,
    calls: 0,
    render: jest.fn(async () => {
      stub.calls++;
      return typeof result === 'function' ? result() : result;
    }),
  } as unknown as EmbedRenderer & { calls: number };
  return stub;
};

const input = (overrides: Partial<EmbedInput> = {}): EmbedInput => ({
  tag: 'echo',
  url: 'hello',
  pageId: overrides.pageId ?? new Types.ObjectId().toHexString(),
});

// The background re-render is a fire-and-forget chain whose internal awaits
// (real Mongo I/O) produce a variable number of microtasks / event-loop turns
// before `renderer.calls` increments. A fixed `setImmediate` tick count was
// flaky under parallel load (the I/O round-trip can spill past two ticks).
// Poll by yielding the event loop until the expected call count appears, with
// a safety bound — mirrors `backlink.test.ts`'s `waitForBacklinks`.
const waitForCalls = async (renderer: { calls: number }, expectedCalls: number, maxTicks = 50): Promise<void> => {
  for (let i = 0; i < maxTicks; i += 1) {
    if (renderer.calls === expectedCalls) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('cachedRender stale-while-revalidate', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  it('miss → render() runs and cache is populated', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<x/>', ttlSec: 300 });

    const result = await cachedRender(storage, PLUGIN, renderer, input(), ctx);

    expect(result.freshness).toBe('fresh');
    expect(result.html).toBe('<x/>');
    expect(renderer.calls).toBe(1);
  });

  it('hit & fresh → cached html returned, render() not re-run', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<x/>', ttlSec: 300 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(renderer.calls).toBe(1);

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.freshness).toBe('fresh');
    expect(result.html).toBe('<x/>');
    expect(renderer.calls).toBe(1);
  });

  it('hit & stale-within-window → returns cached + fires background re-render', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<v1/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(renderer.calls).toBe(1);

    // Move `expiresAt` to the past but still inside the stale window
    // (ttlSec*4 = 4s). 2s ago: stale-fresh-bg.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 2_000);
    const fetchedAtFromPast = new Date(past.getTime() - 1_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: fetchedAtFromPast } },
    ).exec();

    // Change the renderer payload so background re-render produces v2.
    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '<v2/>', ttlSec: 1 };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.freshness).toBe('stale');
    expect(result.html).toBe('<v1/>');

    // Background re-render should fire — poll until the call count settles
    // rather than draining a fixed number of ticks.
    await waitForCalls(renderer, 2);
    expect(renderer.calls).toBe(2);
  });

  it('hit & past stale window → blocks on re-render, returns new html as fresh', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<v1/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    // 10s past expiresAt — stale-window is ttlSec*DEFAULT_STALE_MULTIPLIER = 4s → expired.
    const past = new Date(Date.now() - 10_000);
    const fetchedAtFromPast = new Date(past.getTime() - 1_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: fetchedAtFromPast } },
    ).exec();

    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '<v2/>', ttlSec: 1 };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.freshness).toBe('fresh');
    expect(result.html).toBe('<v2/>');
    expect(renderer.calls).toBe(2);
  });
});

describe('error caching', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const errCases = [
    { code: 'auth' as const, expectedTtlSec: RENDER_ERROR_TTL.auth },
    { code: 'rate_limit' as const, expectedTtlSec: RENDER_ERROR_TTL.rate_limit },
    { code: 'not_found' as const, expectedTtlSec: RENDER_ERROR_TTL.not_found },
    { code: 'network' as const, expectedTtlSec: RENDER_ERROR_TTL.network },
    { code: 'timeout' as const, expectedTtlSec: RENDER_ERROR_TTL.timeout },
    { code: 'unknown' as const, expectedTtlSec: RENDER_ERROR_TTL.unknown },
  ];

  it.each(errCases)('caches %s errors with the per-code default TTL', async ({ code, expectedTtlSec }) => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', error: { code } });
    const i = input();
    const before = Date.now();
    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toContain(`crowi-embed-placeholder-error-${code}`);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) })
      .lean()
      .exec();
    expect(doc).not.toBeNull();
    const ttlSec = Math.round((doc!.expiresAt.getTime() - before) / 1000);
    expect(ttlSec).toBeGreaterThanOrEqual(expectedTtlSec - 1);
    expect(ttlSec).toBeLessThanOrEqual(expectedTtlSec + 1);
  });

  it('rate_limit error with retryAfterSec overrides the default TTL', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', error: { code: 'rate_limit', retryAfterSec: 30 } });
    const i = input();
    const before = Date.now();
    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) })
      .lean()
      .exec();
    const ttlSec = Math.round((doc!.expiresAt.getTime() - before) / 1000);
    expect(ttlSec).toBeGreaterThanOrEqual(29);
    expect(ttlSec).toBeLessThanOrEqual(31);
  });

  it('thrown errors are normalized to {code: "unknown"} and cached', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer: EmbedRenderer = {
      cacheVersion: 1,
      render: async () => {
        throw new Error('boom');
      },
    };
    const result = await cachedRender(storage, PLUGIN, renderer, input(), ctx);
    expect(result.html).toContain('crowi-embed-placeholder-error-unknown');
  });
});

describe('default TTLs', () => {
  it('uses DEFAULT_FRESH_TTL_SEC when render() omits ttlSec', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<x/>' });
    const i = input();
    const before = Date.now();
    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) })
      .lean()
      .exec();
    const ttlSec = Math.round((doc!.expiresAt.getTime() - before) / 1000);
    expect(ttlSec).toBeGreaterThanOrEqual(DEFAULT_FRESH_TTL_SEC - 1);
    expect(ttlSec).toBeLessThanOrEqual(DEFAULT_FRESH_TTL_SEC + 1);
  });

  it('DEFAULT_STALE_MULTIPLIER is exported and >= 1', () => {
    expect(DEFAULT_STALE_MULTIPLIER).toBeGreaterThanOrEqual(1);
  });
});
