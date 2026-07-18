import type { EmbedInput, EmbedRenderer, PluginLogger, RenderContext, RenderResult } from '@crowi/plugin-api';
import { Types } from 'mongoose';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { createAuthContextStub } from '../registry';
import {
  cachedRender,
  DEFAULT_FRESH_TTL_SEC,
  DEFAULT_STALE_MULTIPLIER,
  MAX_TTL_SEC,
  RENDER_ERROR_TTL,
  STALE_IF_ERROR_MAX_AGE_SEC,
  scopeForPlugin,
} from './index';
import { MongoCacheStorage, SINGLE_ENTRY_REJECT_BYTES } from './mongodb-cache';

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

/**
 * `renderer.calls` increments the instant the mock `render()` resolves,
 * but the background job's `storage.setOrReject(...)` write (real Mongo
 * I/O) lands a few event-loop turns later — polling on call count alone
 * isn't enough for assertions against the CACHED DOC after a background
 * revalidation. Poll a predicate over any async value until it's
 * satisfied, with a safety bound — mirrors `backlink.test.ts`'s
 * `waitForBacklinks`.
 */
const waitFor = async <T>(check: () => Promise<T>, predicate: (value: T) => boolean, maxTicks = 50): Promise<T> => {
  let value = await check();
  for (let i = 0; i < maxTicks && !predicate(value); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    value = await check();
  }
  return value;
};

// The background re-render is a fire-and-forget chain whose internal awaits
// (real Mongo I/O) produce a variable number of microtasks / event-loop turns
// before `renderer.calls` increments. A fixed `setImmediate` tick count was
// flaky under parallel load (the I/O round-trip can spill past two ticks).
const waitForCalls = async (renderer: { calls: number }, expectedCalls: number, maxTicks = 50): Promise<void> => {
  await waitFor(
    async () => renderer.calls,
    (calls) => calls === expectedCalls,
    maxTicks,
  );
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
    { code: 'blocked' as const, expectedTtlSec: RENDER_ERROR_TTL.blocked },
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

describe('errorHtml (RenderResult.errorHtml)', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  it('shows errorHtml instead of the generic placeholder when the plugin sets it alongside error', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', errorHtml: '<a href="https://example.test">broken link</a>', error: { code: 'not_found' } });

    const result = await cachedRender(storage, PLUGIN, renderer, input(), ctx);
    expect(result.html).toBe('<a href="https://example.test">broken link</a>');
    expect(result.html).not.toContain('crowi-embed-placeholder-error');
  });

  it('falls back to the generic placeholder when errorHtml is absent (plantuml-style regression, AC-1)', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', error: { code: 'not_found' } });

    const result = await cachedRender(storage, PLUGIN, renderer, input(), ctx);
    expect(result.html).toContain('crowi-embed-placeholder-error-not_found');
  });

  it('an oversized errorHtml is rejected by the entry size limit like any other cache entry (no special-casing)', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const oversizedErrorHtml = 'x'.repeat(SINGLE_ENTRY_REJECT_BYTES + 1);
    const renderer = buildRenderer({ html: '', errorHtml: oversizedErrorHtml, error: { code: 'not_found' } });

    const result = await cachedRender(storage, PLUGIN, renderer, input(), ctx);
    expect(result.html).toContain('crowi-embed-placeholder-error-size-limit');
  });
});

describe('stale-if-error (last-good retention)', () => {
  beforeEach(async () => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const findDoc = async (pageId: string) => {
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    return PluginRenderCache.findOne({ pluginName: PLUGIN, pageId: new Types.ObjectId(pageId) })
      .lean()
      .exec();
  };

  it('(a) keeps the last-good html when a BACKGROUND revalidation fails, within STALE_IF_ERROR_MAX_AGE_SEC', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<good/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);
    const before = await findDoc(i.pageId);
    // New invariant: success entries do NOT carry lastGoodFetchedAt (their
    // fetchedAt IS the last-good time) — the field appears only once a failed
    // revalidation retains this html (asserted below).
    expect(before?.lastGoodFetchedAt).toBeUndefined();

    // Push into the stale-within-window bucket — same shape as the plain
    // stale-while-revalidate background test above.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 2_000);
    const pushedFetchedAt = new Date(past.getTime() - 1_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: pushedFetchedAt } },
    ).exec();

    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '', error: { code: 'network' } };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    // Immediate response is still the pre-failure cached entry.
    expect(result.freshness).toBe('stale');
    expect(result.html).toBe('<good/>');

    await waitForCalls(renderer, 2);
    // `renderer.calls` increments the instant render() resolves, but the
    // background job's storage write lands a few ticks later — wait for
    // the doc to actually reflect the new error before asserting on it.
    const after = await waitFor(
      () => findDoc(i.pageId),
      (doc) => (doc?.result as RenderResult | undefined)?.error !== undefined,
    );
    expect(after?.html).toBe('<good/>'); // kept, NOT degraded to a placeholder
    expect((after?.result as RenderResult).error?.code).toBe('network'); // new error recorded for telemetry/retry cadence
    // The retained entry materializes lastGoodFetchedAt from the prior
    // SUCCESS entry's fetchedAt (success entries don't carry the field).
    expect(after?.lastGoodFetchedAt?.getTime()).toBe(pushedFetchedAt.getTime());
  });

  it('(b) keeps the last-good html when a BLOCKING revalidation fails, within STALE_IF_ERROR_MAX_AGE_SEC', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<good/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);
    const before = await findDoc(i.pageId);
    // New invariant: success entries do NOT carry lastGoodFetchedAt (their
    // fetchedAt IS the last-good time) — the field appears only once a failed
    // revalidation retains this html (asserted below).
    expect(before?.lastGoodFetchedAt).toBeUndefined();

    // Past the stale window entirely (ttlSec=1 -> window=4s) -> blocking path.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 10_000);
    const pushedFetchedAt = new Date(past.getTime() - 1_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: pushedFetchedAt } },
    ).exec();

    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '', error: { code: 'network' } };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toBe('<good/>'); // kept even though THIS render() call failed
    expect(result.result.error?.code).toBe('network');

    const after = await findDoc(i.pageId);
    expect(after?.html).toBe('<good/>');
    expect(after?.lastGoodFetchedAt?.getTime()).toBe(pushedFetchedAt.getTime());
  });

  it('(c) degrades to the placeholder once the last-good exceeds STALE_IF_ERROR_MAX_AGE_SEC (BLOCKING)', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<good/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    // The honest shape of an aged SUCCESS entry under the "field present ⇔
    // stale-if-error entry" invariant: its last-good time IS its fetchedAt,
    // so age the entry itself just past 24h (expiresAt = fetchedAt + its 1s
    // ttl — long past the 4s stale window, hence the blocking path).
    const ancientFetchedAt = new Date(Date.now() - (STALE_IF_ERROR_MAX_AGE_SEC + 3_600) * 1000); // just over 24h ago
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: new Date(ancientFetchedAt.getTime() + 1_000), fetchedAt: ancientFetchedAt } },
    ).exec();

    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '', error: { code: 'network' } };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toContain('crowi-embed-placeholder-error-network'); // degraded — no more keeping

    const after = await findDoc(i.pageId);
    expect(after?.lastGoodFetchedAt).toBeUndefined();
  });

  it('(d) degrades to the placeholder once the last-good exceeds STALE_IF_ERROR_MAX_AGE_SEC (BACKGROUND)', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<good/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    // A recently-refreshed entry whose LAST-GOOD is ancient can only be a
    // stale-if-error entry mid-retry-cadence (the chained-retention state —
    // the one place `lastGoodFetchedAt` legitimately exists). Model exactly
    // that: an error entry still showing '<good/>', whose original success
    // is just past 24h old, re-entering revalidation on the background path.
    const ancientLastGood = new Date(Date.now() - (STALE_IF_ERROR_MAX_AGE_SEC + 3_600) * 1000);
    const past = new Date(Date.now() - 2_000); // within the stale window (4s) -> background
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      {
        $set: {
          expiresAt: past,
          fetchedAt: new Date(past.getTime() - 1_000),
          lastGoodFetchedAt: ancientLastGood,
          result: { html: '<good/>', error: { code: 'network', message: 'prior failed revalidation' } },
        },
      },
    ).exec();

    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '', error: { code: 'network' } };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    // The immediate response still serves the (soon-to-be-degraded) cached html.
    expect(result.freshness).toBe('stale');
    expect(result.html).toBe('<good/>');

    await waitForCalls(renderer, 2);
    const after = await waitFor(
      () => findDoc(i.pageId),
      (doc) => doc?.html !== '<good/>',
    );
    expect(after?.html).toContain('crowi-embed-placeholder-error-network');
    expect(after?.lastGoodFetchedAt).toBeUndefined();
  });

  it('(e) no prior success at all (miss) degrades immediately — no lastGoodFetchedAt is ever written', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', error: { code: 'network' } });
    const i = input();

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toContain('crowi-embed-placeholder-error-network');

    const doc = await findDoc(i.pageId);
    expect(doc?.lastGoodFetchedAt).toBeUndefined();
  });

  it('(f) a policy-level rejection (blocked) does NOT retain the last-good html — policy takes effect on the next revalidation, not 24h later', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '<good/>', ttlSec: 1 });
    const i = input();

    await cachedRender(storage, PLUGIN, renderer, i, ctx);

    // Past the stale window entirely (ttlSec=1 -> window=4s) -> blocking path.
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 10_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: new Date(past.getTime() - 1_000) } },
    ).exec();

    // The host got blocklisted since the last success (e.g. an SSRF
    // blocklist update) — `blocked` is not in
    // STALE_IF_ERROR_RETAINABLE_CODES, so the previously-fetched html
    // must NOT stay on screen.
    (renderer as { render: jest.Mock }).render.mockImplementationOnce(async () => {
      (renderer as unknown as { calls: number }).calls++;
      return { html: '', errorHtml: '<a href="https://example.test">blocked link</a>', error: { code: 'blocked' } };
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toBe('<a href="https://example.test">blocked link</a>'); // degraded, NOT '<good/>'

    const after = await findDoc(i.pageId);
    expect(after?.html).toBe('<a href="https://example.test">blocked link</a>');
    expect(after?.lastGoodFetchedAt).toBeUndefined();
  });

  it('clamps an untrusted plugin-supplied TTL (huge retryAfterSec / huge ttlSec) to MAX_TTL_SEC at the core boundary', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const i = input();

    // A year-long upstream Retry-After must not produce a year-long entry.
    const rateLimited = buildRenderer({ html: '', error: { code: 'rate_limit', retryAfterSec: 60 * 60 * 24 * 365 } });
    const before = Date.now();
    await cachedRender(storage, PLUGIN, rateLimited, i, ctx);
    const doc = await findDoc(i.pageId);
    const ttlMs = doc!.expiresAt.getTime() - before;
    expect(ttlMs).toBeLessThanOrEqual(MAX_TTL_SEC * 1000 + 5_000);
    expect(ttlMs).toBeGreaterThan((MAX_TTL_SEC - 60) * 1000);

    // Success-path ttlSec is clamped through the same chokepoint.
    const i2 = input();
    const longLived = buildRenderer({ html: '<ok/>', ttlSec: 60 * 60 * 24 * 365 });
    const before2 = Date.now();
    await cachedRender(storage, PLUGIN, longLived, i2, ctx);
    const doc2 = await findDoc(i2.pageId);
    const ttlMs2 = doc2!.expiresAt.getTime() - before2;
    expect(ttlMs2).toBeLessThanOrEqual(MAX_TTL_SEC * 1000 + 5_000);
    expect(ttlMs2).toBeGreaterThan((MAX_TTL_SEC - 60) * 1000);
  });

  it('treats a pre-migration success entry (no lastGoodFetchedAt on disk) as good as its own fetchedAt — no backfill needed', async () => {
    const storage = buildStorage();
    const ctx = buildCtx(storage, PLUGIN);
    const renderer = buildRenderer({ html: '', error: { code: 'network' } });
    renderer.computeEmbedKey = () => 'legacy-key';
    const i = input();

    // A doc written before `lastGoodFetchedAt` existed: a success entry
    // with the field entirely absent, expired well beyond any plausible
    // stale window (forcing the blocking re-render path).
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.create({
      pluginName: PLUGIN,
      pluginCacheVersion: renderer.cacheVersion,
      pageId: new Types.ObjectId(i.pageId),
      embedKey: 'legacy-key',
      html: '<legacy-good/>',
      fetchedAt: new Date(Date.now() - 100_000),
      expiresAt: new Date(Date.now() - 90_000),
      result: { html: '<legacy-good/>' },
    });

    const result = await cachedRender(storage, PLUGIN, renderer, i, ctx);
    expect(result.html).toBe('<legacy-good/>'); // kept via the fetchedAt fallback, not degraded
  });
});
