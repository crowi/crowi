import Debug from 'debug';
import type { PluginLogger, RenderContext } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, type PipelineMetadata, type PipelineResult, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';
import { serializeMdast } from './serialize';

export type { PipelineMetadata, PipelineResult, PipelineEsmDeps, ShikiHighlighter } from './pipeline';
export { RendererRegistryImpl, makeRendererScope } from './registry';
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
  /** Run the parse + transform pipeline against `body`. */
  run(body: string, options?: { mode?: RenderContext['mode'] }): Promise<PipelineResult>;
  /** Convenience: just the metadata (used by `prepareRevision` + on-the-fly fallback). */
  runMetadata(body: string, options?: { mode?: RenderContext['mode'] }): Promise<PipelineMetadata>;
  /**
   * Convenience: run the pipeline and return both metadata and the
   * JSON-serialisable rendered AST. Used by `prepareRevision` (save
   * path) and by `computeRevisionRenderedAstAsync` (read-path on-the-
   * fly fallback for legacy revisions).
   */
  runRender(body: string, options?: { mode?: RenderContext['mode'] }): Promise<{ metadata: PipelineMetadata; renderedAst: unknown }>;
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
 */
export function createRenderer(): Renderer {
  const registry = new RendererRegistryImpl();
  // Per-instance ESM-deps loader. Sharing a module-level cache breaks
  // under jest where each test file boots a fresh `Crowi` and a torn
  // down test environment leaves cached ESM modules pointing at a
  // dead VM realm.
  const loadDeps = createPipelineEsmDepsLoader();

  return {
    registry,
    async run(body, options = {}) {
      const ctx: RenderContext = { mode: options.mode ?? 'save', log: coreLogger };
      return runPipeline(body, registry, ctx, loadDeps);
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
  };
}
