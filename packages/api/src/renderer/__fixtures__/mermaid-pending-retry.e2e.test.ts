import type { CodeBlockRenderer, PluginLogger, RenderContext } from '@crowi/plugin-api';
import type { Code, Root } from 'mdast';
import { Types } from 'mongoose';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { crowi } from 'src/test/setup';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { hasPendingRenderMarker, makeCodeBlockDispatch, redispatchPendingCodeBlocks } from '../core';
import * as renderAdmission from '../core/render-admission';
import { _resetAllPoolsForTest, acquireRenderSlot, type RenderSlotTicket } from '../core/render-admission';
import { createAuthContextStub, makeRendererScope, RendererRegistryImpl } from '../registry';
import { serializeMdast } from '../serialize';

/**
 * End-to-end (save → pending marker → read-time retry → resolved) test
 * for spec §5's classification-B self-healing loop.
 *
 * The injected infra failure is a REAL admission-control queue overflow
 * — not a scripted `render()` throw. `injectRealAdmissionFailure` calls
 * the actual `acquireRenderSlot` (`../core/render-admission.ts`, the
 * SAME module `cachedRenderOrPending` calls internally) and holds the
 * ticket open, genuinely saturating `PLUGIN`'s admission pool (sized
 * `maxConcurrentGlobal:1, queueDepth:0` so saturation is trivial to
 * force deterministically). Every dispatch attempt made while the
 * ticket is held hits a real `RenderAdmissionQueueOverflowError` thrown
 * from `render-admission.ts` itself, propagated through
 * `cachedRenderOrPending` exactly the way a genuine save-time-under-load
 * or a genuine child-process-timeout/crash infra failure would (spec §5
 * classification B treats admission rejection and a thrown `render()`
 * identically — this test exercises the admission half for real; the
 * child-process-timeout half is already exercised for real by
 * `render-engine.ts`'s own timeout unit test in
 * `@crowi/plugin-renderer-mermaid`).
 *
 * The `CodeBlockRenderer.render()` callback itself stays a lightweight
 * stub (not the real, child-process-forking Mermaid engine) — the real
 * engine's own success/error/timeout/crash behaviour is already covered
 * exhaustively by Phase 0's spike suite and `mermaid.e2e.test.ts`; this
 * fixture's job is the pending-marker/re-dispatch LIFECYCLE, which is
 * identical regardless of which infra failure triggered it, so gating
 * that lifecycle behind a genuine `render-admission.ts` rejection (as
 * opposed to a fake throw the renderer chooses to perform) is what
 * actually proves `makeCodeBlockDispatch` / `cachedRenderOrPending` /
 * `redispatchPendingCodeBlocks` behave correctly under a real infra
 * failure, not merely under a cooperative test double.
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const PLUGIN = '@crowi/plugin-fixture-pending-retry';
// Deliberately tight — the real Mermaid plugin registers 4/2/200 (spec
// §6), but a single global slot + zero queue depth is what makes a REAL
// overflow trivial to force deterministically in a test: hold the one
// slot open via a directly-acquired ticket, and any concurrent dispatch
// attempt genuinely rejects (no timing races, no artificial delays).
const TIGHT_ADMISSION_CONFIG = { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1, queueDepth: 0 };

describe('e2e: save-fail → pending marker → read-time retry → resolved (spec §5 classification B)', () => {
  let pageId: string;
  let renderCallCount: number;
  let heldTicket: RenderSlotTicket | null;

  const renderer: CodeBlockRenderer = {
    cacheVersion: 1,
    admissionControl: TIGHT_ADMISSION_CONFIG,
    async render(info) {
      renderCallCount += 1;
      return {
        html: `<img class="diagram-embed mermaid-embed" alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(info.source).toString('base64')}">`,
        ttlSec: 3600,
      };
    },
  };

  /**
   * Genuinely saturate `PLUGIN`'s real admission pool by holding its one
   * global slot open — the same `render-admission.ts` pool
   * `cachedRenderOrPending` acquires from internally. Any dispatch
   * attempt made while this ticket is held hits a real
   * `RenderAdmissionQueueOverflowError`, not a scripted failure.
   */
  const injectRealAdmissionFailure = async (): Promise<void> => {
    heldTicket = await acquireRenderSlot({
      pluginName: PLUGIN,
      actor: { kind: 'system' },
      priority: 'low',
      admissionControl: TIGHT_ADMISSION_CONFIG,
    });
  };

  /** Recovery: release the held ticket, freeing the pool's one slot for real dispatch attempts to actually acquire. */
  const clearInjectedFailure = (): void => {
    heldTicket?.release();
    heldTicket = null;
  };

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    renderCallCount = 0;
    heldTicket = null;
    _resetAllPoolsForTest();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
    // Every test starts in the "failing" state — mirrors the previous
    // fixture's `shouldFail = true` default.
    await injectRealAdmissionFailure();
  });

  const buildRegistry = () => {
    const reg = new RendererRegistryImpl();
    makeRendererScope(reg, PLUGIN, silentLogger).addCodeBlockRenderer('mermaid', renderer);
    return reg;
  };

  const buildCtx = (storage: ReturnType<typeof createMongoCacheStorage>): RenderContext => ({
    mode: 'save',
    log: silentLogger,
    actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
    cache: scopeForPlugin(storage, PLUGIN),
    auth: createAuthContextStub(),
  });

  it('(1) a real admission-queue-overflow at save time sets the pending marker, the save "succeeds" (node untouched), render() is never reached, and nothing is cached', async () => {
    const reg = buildRegistry();
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage);

    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' } as Code] };
    await makeCodeBlockDispatch(reg, ctx, { cache: storage, pageId })(tree);

    const node = tree.children[0] as Code & { data?: { renderPending?: boolean } };
    expect(node.type).toBe('code'); // untouched — "save succeeds" (no exception, no error placeholder baked in)
    expect(node.data?.renderPending).toBe(true);
    // Admission rejects BEFORE `renderer.render()` is ever invoked (spec
    // §5/§6 — the ticket gate wraps the actual render call).
    expect(renderCallCount).toBe(0);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const count = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(count).toBe(0);

    // The marker survives `serializeMdast` (what actually gets persisted
    // into `Revision.renderedAst`) — position is stripped, `data` is not.
    const serialized = serializeMdast(tree) as Root;
    const serializedNode = serialized.children[0] as Code & { data?: { renderPending?: boolean } };
    expect(serializedNode.data?.renderPending).toBe(true);
  });

  it('(2) reading while the real admission overflow persists re-attempts admission (a genuine retry, not a no-op), stays pending, and still writes nothing to the cache', async () => {
    const reg = buildRegistry();
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage);

    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' } as Code] };
    await makeCodeBlockDispatch(reg, ctx, { cache: storage, pageId })(tree);
    expect(hasPendingRenderMarker(tree)).toBe(true);

    // Prove the read-time retry genuinely re-attempts admission (not a
    // short-circuit that skips straight to "still pending" without
    // trying) by spying on the real `acquireRenderSlot`.
    const acquireSpy = jest.spyOn(renderAdmission, 'acquireRenderSlot');
    const callsBeforeRetry = acquireSpy.mock.calls.length;

    const readCtx: RenderContext = { ...ctx, mode: 'read' };
    const { changed } = await redispatchPendingCodeBlocks(tree, reg, readCtx, { cache: storage, pageId });

    expect(acquireSpy.mock.calls.length).toBeGreaterThan(callsBeforeRetry); // a real admission attempt actually happened
    expect(changed).toBe(false);
    expect(renderCallCount).toBe(0); // still never reached — admission still saturated
    const node = tree.children[0] as Code & { data?: { renderPending?: boolean } };
    expect(node.type).toBe('code');
    expect(node.data?.renderPending).toBe(true);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const count = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(count).toBe(0);

    acquireSpy.mockRestore();
  });

  it('(3) once the real admission failure is cleared (the held slot released), the next read resolves the pending node and caches the success', async () => {
    const reg = buildRegistry();
    const storage = createMongoCacheStorage(crowi);
    const ctx = buildCtx(storage);

    const tree: Root = { type: 'root', children: [{ type: 'code', lang: 'mermaid', value: 'flowchart TD\n  A --> B' } as Code] };
    await makeCodeBlockDispatch(reg, ctx, { cache: storage, pageId })(tree);
    expect(hasPendingRenderMarker(tree)).toBe(true);

    // Infra recovers — release the real ticket, freeing the pool's one slot.
    clearInjectedFailure();
    const readCtx: RenderContext = { ...ctx, mode: 'read' };
    const { changed } = await redispatchPendingCodeBlocks(tree, reg, readCtx, { cache: storage, pageId });

    expect(changed).toBe(true);
    expect(renderCallCount).toBe(1); // this time admission actually granted a slot and render() ran.
    const node = tree.children[0] as unknown as { type: string; value?: string };
    expect(node.type).toBe('html');
    expect((node as { value: string }).value).toContain('<img');
    expect(hasPendingRenderMarker(tree)).toBe(false);

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pageId: new Types.ObjectId(pageId) })
      .lean()
      .exec();
    expect(doc).toBeTruthy();
    expect(doc?.html).toContain('<img');

    // A subsequent read with no marker left does nothing (fresh cache hit,
    // no further render() calls) — `redispatchPendingCodeBlocks` itself is
    // only ever invoked when `hasPendingRenderMarker` is true in the
    // production call site (`page-response.ts`), which this proves is now false.
  });
});
