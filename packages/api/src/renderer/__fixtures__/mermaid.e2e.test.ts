import { Types } from 'mongoose';
import type { PluginContext, PluginLogger, RenderContext } from '@crowi/plugin-api';
import mermaidPlugin, { _shutdownSingletonForTest } from '@crowi/plugin-renderer-mermaid';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';

/**
 * e2e (real pipeline, `code-block-dispatch.ts`) coverage for
 * `@crowi/plugin-renderer-mermaid`, mirroring `plantuml.e2e.test.ts`'s
 * shape exactly (spec §2's own requirement: "実際にhast-util-raw→JSX変換
 * を通した結果...でテストする" is a proxy for "the final output structurally
 * cannot carry an executable payload" — this suite proves that structural
 * guarantee at the mdast level, the same level `plantuml.e2e.test.ts`
 * tests at. `packages/web`'s `hast-util-raw` / JSX conversion (which this
 * suite intentionally does not invoke — that machinery is web-only, not
 * an `@crowi/api` dependency) has no position to smuggle a `<script>` /
 * `onerror=` / `javascript:` construct into, because layer 3 (spec §2)
 * already reduces the entire diagram to a single opaque
 * `data:image/svg+xml;base64,...` `src` attribute on a plain `<img>` —
 * there is no HTML structure left for a raw-HTML pass to reinterpret.
 */

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-renderer-mermaid';

const buildPluginCtx = (): PluginContext =>
  ({
    config: <T>() => undefined as T,
    dependencyConfig: () => {
      throw new Error('not used by this test');
    },
    setConfig: async () => undefined,
    pageMetadata: {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    },
    model: () => undefined,
    log: silentLogger,
  }) as PluginContext;

describe('e2e: @crowi/plugin-renderer-mermaid', () => {
  let pageId: string;

  // Every render() call in this suite goes through the real plugin, which
  // lazily forks a child-process pool on first use (`render-engine.ts`).
  // Without this, the forked `render-worker` processes outlive the test
  // file and Jest's worker fails to exit gracefully.
  afterAll(async () => {
    await _shutdownSingletonForTest();
  });

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
  });

  const buildRegistryAndCtx = () => {
    const reg = new RendererRegistryImpl();
    mermaidPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), buildPluginCtx());
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'save',
      log: silentLogger,
      actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    return { reg, storage, ctx };
  };

  it('renders a ```mermaid fence into a self-contained <img> html node', async () => {
    const { reg, ctx, storage } = buildRegistryAndCtx();
    const body = ['```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    const html = (top as { value: string }).value;
    expect(html).toContain('<img');
    expect(html).toContain('class="diagram-embed mermaid-embed"');
    expect(html).toContain('src="data:image/svg+xml;base64,');
  }, 30_000);

  it('caches the rendered result and skips the render engine on a second run with the same body', async () => {
    const { reg, ctx, storage } = buildRegistryAndCtx();
    const body = ['```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n');
    const first = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect((first.tree.children[0] as { value: string }).value).toContain('<img');

    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const cachedCountAfterFirst = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(cachedCountAfterFirst).toBe(1);

    // Fresh registry (mirrors a new request), same body + pageId → cache hit.
    const reg2 = new RendererRegistryImpl();
    mermaidPlugin.registerRenderer?.(makeRendererScope(reg2, PLUGIN, silentLogger), buildPluginCtx());
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect((second.tree.children[0] as { value: string }).value).toContain('<img');
    // Still exactly one row — the cache hit did not write a duplicate/second entry.
    const cachedCountAfterSecond = await PluginRenderCache.countDocuments({ pageId: new Types.ObjectId(pageId) }).exec();
    expect(cachedCountAfterSecond).toBe(1);
  }, 30_000);

  it('a diagram label crafted with a sanitize-target payload (script / onload / javascript:) never survives into the output as executable markup', async () => {
    const { reg, ctx, storage } = buildRegistryAndCtx();
    // Mermaid itself escapes label text into safe SVG <text> content (no
    // htmlLabels, securityLevel:'strict', spec §1/§2 layer 1) — this
    // fixture exists to prove the DEFENSE-IN-DEPTH holds even so: no
    // matter what happens upstream, the final HTML this plugin returns
    // is structurally incapable of carrying a `<script>` tag, an
    // `on*=` handler, or a `javascript:` URL, because everything is
    // reduced to a single base64 `data:` URL on a plain `<img>` (layer 3).
    const body = ['```mermaid', 'flowchart TD', '  A["<script>alert(1)</script> onerror=alert(2) javascript:alert(3)"] --> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    const top = result.tree.children[0];
    const html = (top as { type: string; value?: string }).type === 'html' ? (top as { value: string }).value : '';
    expect(html).toContain('<img');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    // The only place attacker-influenced bytes could end up is inside the
    // opaque base64 payload of the `src` attribute — which the browser
    // treats as image bytes, never as markup/script to execute.
    //
    // This proves the plugin's OWN output string is clean. The
    // complementary half — that running this exact `<img class=
    // "diagram-embed mermaid-embed" ...>` shape through the real
    // production `hast-util-raw` → `hast-util-to-jsx-runtime` conversion
    // (`@crowi/web`'s `render-mdast.ts`, the only place that machinery
    // exists — `@crowi/api` has no dependency on it, spec's own e2e
    // fixture cannot invoke it directly) still produces no executable
    // markup — is covered by `packages/web/src/components/editor/
    // render-mdast.test.tsx`'s "a Mermaid <img> whose base64 payload
    // embeds script/onerror/javascript: bytes never resurfaces them as
    // executable markup after hast-util-raw/JSX" test (defense-in-depth,
    // hand-built payload) AND its "a genuine @crowi/plugin-renderer-
    // mermaid render() output, run through the real pipeline" describe
    // block (the same real plugin this file drives, its genuine `<img>`
    // output fed through the real hast-util-raw/JSX conversion — no
    // hand-built HTML).
  }, 30_000);

  it('rejects a %%{init:...}%% directive with the fixed error placeholder (not RenderResult.error) and does not cache it', async () => {
    const { reg, ctx, storage } = buildRegistryAndCtx();
    const body = ['```mermaid', 'flowchart TD', '  A --> B', '  %%{init: {"securityLevel":"loose"}}%%', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    const top = result.tree.children[0];
    const html = (top as { value: string }).value;
    expect(html).toContain('mermaid-error');

    // Classification A results ARE cached (5-min TTL) — confirm the
    // explicit `DEFAULT_FRESH_TTL_SEC` path, not a 1h EmbedFragment
    // fallback (`code-block-dispatch.ts`'s `isRenderResult` trap).
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    const doc = await PluginRenderCache.findOne({ pageId: new Types.ObjectId(pageId) })
      .lean()
      .exec();
    expect(doc).toBeTruthy();
    const ttlMs = (doc?.expiresAt.getTime() ?? 0) - (doc?.fetchedAt.getTime() ?? 0);
    expect(ttlMs).toBe(5 * 60 * 1000);
  }, 30_000);

  it('skips dispatch for unregistered code-block langs', async () => {
    const reg = new RendererRegistryImpl();
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'save',
      log: silentLogger,
      actor: { kind: 'user', userId: new Types.ObjectId().toHexString() },
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    const body = ['```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(result.tree.children[0].type).toBe('code');
  });
});
