import Debug from 'debug';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import type Crowi from 'src/crowi';
import { type MongoCacheStorage, createMongoCacheStorage } from './cache';
import { createPipelineEsmDepsLoader, type LoadPipelineEsmDeps, type PipelineMetadata, type PipelineResult, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';
import { serializeMdast } from './serialize';

export type { PipelineMetadata, PipelineResult, PipelineEsmDeps, ShikiHighlighter } from './pipeline';
export { RendererRegistryImpl, makeRendererScope, createAuthContextStub } from './registry';
export { serializeMdast } from './serialize';

/**
 * The renderer surface attached to `Crowi.renderer` after
 * `setupRenderer()` runs. The registry holds **external plugin
 * additions** only — the bundled core 5 transforms are baked into
 * `runPipeline` and prepended on every run. Plugins layer on top via
 * `PluginManager.activate()`'s `registerRenderer` callback.
 */
export interface Renderer {
  registry: RendererRegistryImpl;
  /**
   * Plugin cache storage. Phase 4 — MongoDB-backed. Plugins receive a
   * per-plugin scoped view through `RenderContext.cache`; the raw
   * storage is exposed here for admin-side `invalidateAll` /
   * `invalidatePlugin` calls + pageEvent listeners.
   */
  cache: MongoCacheStorage;
  /** Run the parse + transform pipeline against `body`. */
  run(body: string, options?: { mode?: RenderContext['mode']; pageId?: string }): Promise<PipelineResult>;
  /** Convenience: just the metadata (used by `prepareRevision` + on-the-fly fallback). */
  runMetadata(body: string, options?: { mode?: RenderContext['mode']; pageId?: string }): Promise<PipelineMetadata>;
  /**
   * Convenience: run the pipeline and return both metadata and the
   * JSON-serialisable rendered AST. Used by `prepareRevision` (save
   * path) and by `computeRevisionRenderedAstAsync` (read-path on-the-
   * fly fallback for legacy revisions).
   */
  runRender(body: string, options?: { mode?: RenderContext['mode']; pageId?: string }): Promise<{ metadata: PipelineMetadata; renderedAst: unknown }>;
  /**
   * Eagerly initialise heavy ESM-only deps (shiki + unified). Fired
   * fire-and-forget from `Crowi.init`'s `setupRenderer` so the first
   * pipeline run doesn't pay the cold-load cost. Failures are logged
   * but never rethrown — boot must not block on optional warmup.
   */
  warmup(): Promise<void>;
}

const debug = Debug('crowi:renderer');

const coreLogger: PluginLogger = {
  debug: (msg, ...args) => debug(msg, ...args),
  info: (msg, ...args) => debug(`[info] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[crowi:renderer] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[crowi:renderer] ${msg}`, ...args),
};

/**
 * Build the renderer. Called once during `Crowi.init()` AFTER
 * `setupModels` and BEFORE `setupPlugins` so PluginManager can call
 * `registerRenderer(scope, ctx)` on every plugin against the same
 * registry instance the pipeline uses.
 *
 * Takes the Crowi instance so the cache storage (which depends on the
 * `PluginRenderCache` mongoose model) and per-plugin scopes can be
 * built. Tests that don't need cache I/O can pass a stub object
 * exposing a `PluginRenderCache` model.
 */
export function createRenderer(crowi: Crowi): Renderer {
  const registry = new RendererRegistryImpl();
  // Per-instance ESM-deps loader. Sharing a module-level cache breaks
  // under jest where each test file boots a fresh `Crowi` and a torn
  // down test environment leaves cached ESM modules pointing at a
  // dead VM realm.
  const loadDeps: LoadPipelineEsmDeps = createPipelineEsmDepsLoader();
  const cache = createMongoCacheStorage(crowi);

  // RenderContext for the core pipeline (not for plugins). `cache` and
  // `auth` are intentionally absent — the bundled core transforms
  // (headings / wikilinks / mentions / code-blocks / syntax-highlight)
  // never consult either. The dispatch layer (embed-tags /
  // url-inline-expand) attaches a per-plugin `cache` + `auth` before
  // calling into plugin code.
  const buildCtx = (options: { mode?: RenderContext['mode']; pageId?: string } = {}): RenderContext => ({
    mode: options.mode ?? 'save',
    log: coreLogger,
  });

  return {
    registry,
    cache,
    async run(body, options = {}) {
      const ctx = buildCtx(options);
      return runPipeline(body, registry, ctx, loadDeps, { cache, pageId: options.pageId ?? null });
    },
    async runMetadata(body, options = {}) {
      const result = await this.run(body, options);
      return result.metadata;
    },
    async runRender(body, options = {}) {
      const result = await this.run(body, options);
      return {
        metadata: result.metadata,
        renderedAst: serializeMdast(result.tree),
      };
    },
    async warmup() {
      try {
        await loadDeps();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[crowi:renderer] warmup failed (will retry on first run): ${message}`);
      }
    },
  };
}
