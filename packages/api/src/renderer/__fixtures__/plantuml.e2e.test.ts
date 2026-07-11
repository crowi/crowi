import { Types } from 'mongoose';
import type { PluginContext, PluginLogger, RenderContext } from '@crowi/plugin-api';
import plantumlPlugin, { plantumlConfigSchema } from '@crowi/plugin-renderer-plantuml';
import { crowi } from 'src/test/setup';
import type { PluginRenderCacheModel } from 'src/models/plugin-render-cache';
import { createMongoCacheStorage, scopeForPlugin } from '../cache';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl, createAuthContextStub, makeRendererScope } from '../registry';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

const PLUGIN = '@crowi/plugin-renderer-plantuml';
const FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

const buildPluginCtx = (config: ReturnType<typeof plantumlConfigSchema.parse>): PluginContext =>
  ({
    config: <T>() => config as T,
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

describe('e2e: @crowi/plugin-renderer-plantuml', () => {
  let pageId: string;
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    pageId = new Types.ObjectId().toHexString();
    const PluginRenderCache = crowi.model('PluginRenderCache') as unknown as PluginRenderCacheModel;
    await PluginRenderCache.deleteMany({}).exec();
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn();
    (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Partial<{ fetch: unknown }>).fetch;
    }
  });

  it('renders a ```plantuml fence into an html node carrying the fetched SVG', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FAKE_SVG, { status: 200 }));

    const reg = new RendererRegistryImpl();
    const config = plantumlConfigSchema.parse({ serverUrl: 'http://plantuml-test:8080' });
    plantumlPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), buildPluginCtx(config));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```plantuml', '@startuml', 'A -> B', '@enduml', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toMatch(/^http:\/\/plantuml-test:8080\/svg\//);

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    expect((top as { value: string }).value).toContain('plantuml-embed');
    expect((top as { value: string }).value).toContain('<svg');
  });

  it('caches the SVG and skips the fetch on a second run', async () => {
    fetchMock.mockResolvedValueOnce(new Response(FAKE_SVG, { status: 200 }));

    const reg1 = new RendererRegistryImpl();
    const config = plantumlConfigSchema.parse({});
    plantumlPlugin.registerRenderer?.(makeRendererScope(reg1, PLUGIN, silentLogger), buildPluginCtx(config));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```plantuml', '@startuml', 'A -> B', '@enduml', '```'].join('\n');
    await runPipeline(body, reg1, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second run — fresh registry, same body + pageId → cache hit.
    fetchMock.mockClear();
    const reg2 = new RendererRegistryImpl();
    plantumlPlugin.registerRenderer?.(makeRendererScope(reg2, PLUGIN, silentLogger), buildPluginCtx(config));
    const second = await runPipeline(body, reg2, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(second.tree.children[0].type).toBe('html');
    expect((second.tree.children[0] as { value: string }).value).toContain('plantuml-embed');
  });

  it('renders an error placeholder when the server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const reg = new RendererRegistryImpl();
    const config = plantumlConfigSchema.parse({});
    plantumlPlugin.registerRenderer?.(makeRendererScope(reg, PLUGIN, silentLogger), buildPluginCtx(config));

    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };

    const body = ['```plantuml', '@startuml', 'A -> B', '@enduml', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });

    const top = result.tree.children[0];
    expect(top.type).toBe('html');
    expect((top as { value: string }).value).toContain('crowi-embed-placeholder-error-network');
  });

  it('skips dispatch for unregistered code-block langs', async () => {
    // No plugin registered → no fetch, code node passes through.
    const reg = new RendererRegistryImpl();
    const storage = createMongoCacheStorage(crowi);
    const ctx: RenderContext = {
      mode: 'view',
      log: silentLogger,
      cache: scopeForPlugin(storage, PLUGIN),
      auth: createAuthContextStub(),
    };
    const body = ['```plantuml', '@startuml', 'A -> B', '@enduml', '```'].join('\n');
    const result = await runPipeline(body, reg, ctx, loadDeps, { cache: storage, pageId });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tree.children[0].type).toBe('code');
  });
});
