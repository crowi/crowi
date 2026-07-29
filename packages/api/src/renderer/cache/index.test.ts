import { Types } from 'mongoose';
import type { AdmissionControlConfig, EmbedInput, EmbedRenderer, PluginLogger, RenderContext, RenderResult } from '@crowi/plugin-api';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { RENDER_ERROR_TTL, cachedRenderOrPending, scopeForPlugin } from './index';
import { MongoCacheStorage } from './mongodb-cache';
import { createAuthContextStub } from '../registry';
import * as renderAdmission from '../core/render-admission';
import { _resetAllPoolsForTest } from '../core/render-admission';

/**
 * Unit tests for `cachedRenderOrPending` (spec §5/§6, feature-plugin-
 * renderer-mermaid Phase 1, AC "packages/api/src/renderer/cache/index.ts
 * に cachedRenderOrPending が追加されている"). Covers the 5 sub-clauses
 * (a)-(e) verbatim from the AC — `cachedRender` itself is unchanged and
 * already covered by `stale-while-revalidate.test.ts`; this file only
 * exercises the admission-aware sibling.
 */

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

const buildCtx = (storage: MongoCacheStorage, pluginName: string, overrides: Partial<RenderContext> = {}): RenderContext => ({
  mode: 'view',
  log: silentLog,
  actor: { kind: 'system' },
  cache: scopeForPlugin(storage, pluginName),
  auth: createAuthContextStub(),
  ...overrides,
});

const input = (overrides: Partial<EmbedInput> = {}): EmbedInput => ({
  tag: 'mermaid-test',
  url: 'x',
  pageId: overrides.pageId ?? new Types.ObjectId().toHexString(),
});

/** Generous enough that a single job in a test never has to wait — used by tests that aren't exercising queueing/overflow themselves. */
const GENEROUS_ADMISSION: AdmissionControlConfig = { maxConcurrentGlobal: 4, maxConcurrentPerUser: 4, queueDepth: 50 };
/** Exactly one slot, no queueing — used by the admission-rejection tests below to force a deterministic overflow/abort. */
const TIGHT_ADMISSION: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 0 };

const clearCache = async (): Promise<void> => {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  await PluginRenderCache.deleteMany({}).exec();
};

const docFor = async (pluginName: string, pageId: string) => {
  const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
  return PluginRenderCache.findOne({ pluginName, pageId: new Types.ObjectId(pageId) })
    .lean()
    .exec();
};

/** Poll the event loop until `predicate()` is true or `maxTicks` is exhausted — mirrors `stale-while-revalidate.test.ts`'s `waitForCalls`. */
/**
 * Poll until `predicate()` is true, THROWING if it never becomes true. Same
 * contract (and the same reasons) as the copy in
 * `renderer/core/code-block-dispatch.test.ts` — a silent give-up lets a test
 * proceed from a state it never reached and fail later somewhere misleading,
 * and a tick budget bounds nothing when the awaited work is real Mongo I/O.
 */
const waitUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil: predicate did not become true within ${timeoutMs}ms`);
};

describe('cachedRenderOrPending', () => {
  beforeEach(async () => {
    _resetAllPoolsForTest();
    await clearCache();
  });

  // (a) parity: no admissionControl declared.
  it('(a) without renderer.admissionControl, behaves exactly like cachedRender — never touches admission, always kind: "rendered"', async () => {
    const storage = buildStorage();
    const PLUGIN = 'p-parity';
    const ctx = buildCtx(storage, PLUGIN);
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const renderer: EmbedRenderer = { cacheVersion: 1, render: async () => ({ html: '<x/>', ttlSec: 300 }) };
    const i = input();

    const missResult = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
    expect(missResult.kind).toBe('rendered');
    if (missResult.kind === 'rendered') {
      expect(missResult.html).toBe('<x/>');
      expect(missResult.freshness).toBe('fresh');
    }

    const hitResult = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
    expect(hitResult.kind).toBe('rendered');
    if (hitResult.kind === 'rendered') expect(hitResult.freshness).toBe('fresh');

    expect(acquireSpy).not.toHaveBeenCalled();
    acquireSpy.mockRestore();
  });

  // (b) admission rejection or a thrown render() ⇒ pending, storage untouched.
  describe('(b) admission rejection / thrown render() ⇒ { kind: "pending" }, storage.setOrReject never called for that key', () => {
    it('renderer.render() throwing under admission', async () => {
      const storage = buildStorage();
      const PLUGIN = 'p-throw';
      const ctx = buildCtx(storage, PLUGIN);
      const setOrRejectSpy = jest.spyOn(storage, 'setOrReject');
      const renderer: EmbedRenderer = {
        cacheVersion: 1,
        admissionControl: GENEROUS_ADMISSION,
        render: async () => {
          throw new Error('child-process crash');
        },
      };
      const i = input();

      const result = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
      expect(result).toEqual({ kind: 'pending' });
      expect(setOrRejectSpy).not.toHaveBeenCalled();
      expect(await docFor(PLUGIN, i.pageId)).toBeNull();
    });

    it('admission queue overflow (queueDepth exhausted)', async () => {
      const storage = buildStorage();
      const PLUGIN = 'p-overflow';
      const ctx = buildCtx(storage, PLUGIN);
      const setOrRejectSpy = jest.spyOn(storage, 'setOrReject');

      let renderStarted = false;
      let releaseFirst: ((result: RenderResult) => void) | undefined;
      const blocker: EmbedRenderer = {
        cacheVersion: 1,
        admissionControl: TIGHT_ADMISSION, // maxConcurrentGlobal:1, queueDepth:0
        render: () =>
          new Promise<RenderResult>((resolve) => {
            renderStarted = true;
            releaseFirst = resolve;
          }),
      };

      const firstInput = input();
      const firstPromise = cachedRenderOrPending(storage, PLUGIN, blocker, firstInput, ctx, { priority: 'high' });
      await waitUntil(() => renderStarted); // first job now holds the (only) admission slot.

      const secondInput = input(); // distinct cache key ⇒ a genuine new admission attempt, not a cache hit.
      const secondResult = await cachedRenderOrPending(storage, PLUGIN, blocker, secondInput, ctx, { priority: 'high' });
      expect(secondResult).toEqual({ kind: 'pending' });
      // Nothing has been persisted yet (the first job is still blocked mid-render).
      expect(setOrRejectSpy).not.toHaveBeenCalled();
      expect(await docFor(PLUGIN, secondInput.pageId)).toBeNull();

      releaseFirst?.({ html: '<v1/>', ttlSec: 300 });
      const firstResult = await firstPromise;
      expect(firstResult.kind).toBe('rendered');
      expect(setOrRejectSpy).toHaveBeenCalledTimes(1);
      expect(await docFor(PLUGIN, firstInput.pageId)).not.toBeNull();
      expect(await docFor(PLUGIN, secondInput.pageId)).toBeNull();
    });

    it('the ctx.signal aborting while queued', async () => {
      const storage = buildStorage();
      const PLUGIN = 'p-abort';
      const admission: AdmissionControlConfig = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 5 };
      const setOrRejectSpy = jest.spyOn(storage, 'setOrReject');

      let renderStarted = false;
      let releaseFirst: ((result: RenderResult) => void) | undefined;
      const blocker: EmbedRenderer = {
        cacheVersion: 1,
        admissionControl: admission,
        render: () =>
          new Promise<RenderResult>((resolve) => {
            renderStarted = true;
            releaseFirst = resolve;
          }),
      };

      const firstInput = input();
      const firstCtx = buildCtx(storage, PLUGIN);
      const firstPromise = cachedRenderOrPending(storage, PLUGIN, blocker, firstInput, firstCtx, { priority: 'high' });
      await waitUntil(() => renderStarted); // first job holds the only global slot.

      const controller = new AbortController();
      const secondCtx = buildCtx(storage, PLUGIN, { signal: controller.signal });
      const secondInput = input();
      const secondPromise = cachedRenderOrPending(storage, PLUGIN, blocker, secondInput, secondCtx, { priority: 'high' });
      // Wait for the second job's cache lookup (real Mongo round-trip) to
      // resolve and actually enqueue behind the first before aborting it —
      // polls the real admission-pool queue length instead of a fixed
      // wall-clock delay, so this is deterministic regardless of how long
      // the Mongo round-trip takes under load.
      await waitUntil(() => renderAdmission._getQueueLengthForTest(PLUGIN) === 1);
      controller.abort();

      const secondResult = await secondPromise;
      expect(secondResult).toEqual({ kind: 'pending' });
      expect(await docFor(PLUGIN, secondInput.pageId)).toBeNull();

      releaseFirst?.({ html: '<v1/>', ttlSec: 300 });
      await firstPromise;
      expect(setOrRejectSpy).toHaveBeenCalledTimes(1); // only the first (successful) render ever persisted.
    });
  });

  // (c) render() resolves (success OR RenderResult.error, never throws) ⇒ kind: 'rendered', persisted exactly like cachedRender.
  describe('(c) a resolved render() — success or RenderResult.error — is always { kind: "rendered" } and persisted', () => {
    it('a successful result is cached under the admission gate', async () => {
      const storage = buildStorage();
      const PLUGIN = 'p-success';
      const ctx = buildCtx(storage, PLUGIN);
      const renderer: EmbedRenderer = { cacheVersion: 1, admissionControl: GENEROUS_ADMISSION, render: async () => ({ html: '<ok/>', ttlSec: 120 }) };
      const i = input();

      const result = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
      expect(result).toMatchObject({ kind: 'rendered', html: '<ok/>', freshness: 'fresh' });
      expect(await docFor(PLUGIN, i.pageId)).not.toBeNull();
    });

    it('a RenderResult.error (not thrown) is still { kind: "rendered" } with the placeholder persisted at the per-code TTL', async () => {
      const storage = buildStorage();
      const PLUGIN = 'p-error-result';
      const ctx = buildCtx(storage, PLUGIN);
      const renderer: EmbedRenderer = {
        cacheVersion: 1,
        admissionControl: GENEROUS_ADMISSION,
        render: async () => ({ html: '', error: { code: 'timeout' } }),
      };
      const i = input();
      const before = Date.now();

      const result = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
      expect(result.kind).toBe('rendered');
      if (result.kind === 'rendered') expect(result.html).toContain('crowi-embed-placeholder-error-timeout');

      const doc = await docFor(PLUGIN, i.pageId);
      expect(doc).not.toBeNull();
      const ttlSec = Math.round((doc!.expiresAt.getTime() - before) / 1000);
      expect(ttlSec).toBeGreaterThanOrEqual(RENDER_ERROR_TTL.timeout - 1);
      expect(ttlSec).toBeLessThanOrEqual(RENDER_ERROR_TTL.timeout + 1);
    });
  });

  // (d) cache-hit paths (fresh serve, stale immediate serve) never touch admission.
  it('(d) a fresh cache hit and the immediate part of a stale-serve never call acquireRenderSlot', async () => {
    const storage = buildStorage();
    const PLUGIN = 'p-cachehit';
    const ctx = buildCtx(storage, PLUGIN);
    let calls = 0;
    const renderer: EmbedRenderer = {
      cacheVersion: 1,
      admissionControl: GENEROUS_ADMISSION,
      render: async () => {
        calls += 1;
        return { html: `<v${calls}/>`, ttlSec: 1 };
      },
    };
    const i = input();

    // Seed the cache (a genuine miss — this DOES call acquireRenderSlot once).
    await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
    expect(calls).toBe(1);

    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    acquireSpy.mockClear();

    // Fresh hit.
    const freshResult = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
    expect(freshResult).toMatchObject({ kind: 'rendered', freshness: 'fresh' });
    expect(acquireSpy).not.toHaveBeenCalled();

    // Move the entry into the stale window (ttlSec:1 ⇒ stale window is 4s).
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 2_000);
    const fetchedAtFromPast = new Date(past.getTime() - 1_000);
    await PluginRenderCache.updateOne(
      { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
      { $set: { expiresAt: past, fetchedAt: fetchedAtFromPast } },
    ).exec();

    const staleResult = await cachedRenderOrPending(storage, PLUGIN, renderer, i, ctx, { priority: 'high' });
    expect(staleResult).toMatchObject({ kind: 'rendered', freshness: 'stale' });
    // The synchronous stale-serve return itself never calls acquireRenderSlot
    // — only the fire-and-forget background refresh (scheduled via
    // `setImmediate`, asserted separately in (e) below) does.
    expect(acquireSpy).not.toHaveBeenCalled();

    acquireSpy.mockRestore();
    // Let the background refresh this stale-serve triggered actually finish
    // (with the REAL acquireRenderSlot) so no dangling handle survives the test.
    await waitUntil(() => calls === 2);
  });

  // (e) the SWR background refresh path is ALSO admission-gated, across many distinct keys concurrently.
  it('(e) SWR background refresh across many distinct stale keys never runs more than maxConcurrentGlobal renders concurrently', async () => {
    const storage = buildStorage();
    const PLUGIN = 'p-swr-concurrency';
    const admission: AdmissionControlConfig = { maxConcurrentGlobal: 2, maxConcurrentPerUser: 10, queueDepth: 50 };
    const ctx = buildCtx(storage, PLUGIN);

    let seedCalls = 0;
    const seedRenderer: EmbedRenderer = {
      cacheVersion: 1,
      admissionControl: admission,
      render: async () => {
        seedCalls += 1;
        return { html: '<v1/>', ttlSec: 1 };
      },
    };

    const N = 6;
    const inputs = Array.from({ length: N }, () => input());
    // Seed every key (sequential misses — not the phase under test).
    for (const i of inputs) {
      await cachedRenderOrPending(storage, PLUGIN, seedRenderer, i, ctx, { priority: 'high' });
    }
    expect(seedCalls).toBe(N);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const past = new Date(Date.now() - 2_000);
    const fetchedAtFromPast = new Date(past.getTime() - 1_000);
    await Promise.all(
      inputs.map((i) =>
        PluginRenderCache.updateOne(
          { pluginName: PLUGIN, pageId: new Types.ObjectId(i.pageId) },
          { $set: { expiresAt: past, fetchedAt: fetchedAtFromPast } },
        ).exec(),
      ),
    );

    // A render that blocks until explicitly released (never `setTimeout`)
    // — "peak in-flight" this way reflects TRUE concurrency the pool
    // actually granted, not scheduler luck under parallel test-suite CPU
    // contention (a wall-clock-timing version of this assertion was
    // observed to flake under `--maxWorkers` load).
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const pendingReleases: Array<() => void> = [];
    const gatedRenderer: EmbedRenderer = {
      cacheVersion: 1,
      admissionControl: admission,
      render: () =>
        new Promise<RenderResult>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          pendingReleases.push(() => {
            inFlight -= 1;
            completed += 1;
            resolve({ html: '<refreshed/>', ttlSec: 1 });
          });
        }),
    };

    // Trigger the stale-serve (+ scheduled background refresh) for every key, concurrently.
    const staleResults = await Promise.all(inputs.map((i) => cachedRenderOrPending(storage, PLUGIN, gatedRenderer, i, ctx, { priority: 'high' })));
    for (const r of staleResults) {
      expect(r).toMatchObject({ kind: 'rendered', freshness: 'stale' });
    }

    // The pool must admit its first full wave — proves real concurrency
    // actually reached the configured cap, not merely ">1 by luck".
    await waitUntil(() => inFlight === admission.maxConcurrentGlobal);
    expect(peak).toBe(admission.maxConcurrentGlobal);

    // Drain the remaining N - cap jobs wave by wave: release everything
    // currently admitted, let admission grant the next wave, repeat.
    // `peak` must never exceed the cap at any point across every wave.
    while (completed < N) {
      await waitUntil(() => pendingReleases.length > 0 || completed === N);
      if (completed === N) break;
      const wave = pendingReleases.splice(0, pendingReleases.length);
      expect(wave.length).toBeLessThanOrEqual(admission.maxConcurrentGlobal);
      for (const release of wave) release();
    }

    expect(completed).toBe(N);
    expect(peak).toBeLessThanOrEqual(admission.maxConcurrentGlobal);
  }, 15_000);
});
