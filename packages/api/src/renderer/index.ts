import type { PluginLogger, RenderActor, RenderContext } from '@crowi/plugin-api';
import Debug from 'debug';
import type Crowi from 'src/crowi';
import type { UserModel } from 'src/models/user';
import { createMongoCacheStorage, type MongoCacheStorage } from './cache';
import type { MentionUsernameResolver } from './core/mention-resolve';
import { createPipelineEsmDepsLoader, type LoadPipelineEsmDeps, type PipelineMetadata, type PipelineResult, runPipeline } from './pipeline';
import { RendererRegistryImpl } from './registry';
import { serializeMdast } from './serialize';

export type { PipelineEsmDeps, PipelineMetadata, PipelineResult, ShikiHighlighter } from './pipeline';
export { createAuthContextStub, makeRendererScope, RendererRegistryImpl } from './registry';
export { serializeMdast } from './serialize';

/**
 * Options accepted by `Renderer.run`/`runMetadata`/`runRender`. `actor` is
 * required (spec §6 — admission control's per-user concurrency cap needs
 * an actor on every call, end to end); `signal` is optional and only
 * meaningful for the preview call site (`page-preview.ts`), which can
 * propagate the originating request's abort.
 */
export interface RunOptions {
  mode?: RenderContext['mode'];
  pageId?: string;
  actor: RenderActor;
  signal?: AbortSignal;
}

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
  run(body: string, options: RunOptions): Promise<PipelineResult>;
  /** Convenience: just the metadata (used by `prepareRevision` + on-the-fly fallback). */
  runMetadata(body: string, options: RunOptions): Promise<PipelineMetadata>;
  /**
   * Convenience: run the pipeline and return both metadata and the
   * JSON-serialisable rendered AST. Used by `prepareRevision` (save
   * path) and by `computeRevisionRenderedAstAsync` (read-path on-the-
   * fly fallback for legacy revisions).
   */
  runRender(body: string, options: RunOptions): Promise<{ metadata: PipelineMetadata; renderedAst: unknown }>;
  /**
   * Eagerly initialise heavy ESM-only deps (shiki + unified). Fired
   * fire-and-forget from `Crowi.init`'s `setupRenderer` so the first
   * pipeline run doesn't pay the cold-load cost. Failures are logged
   * but never rethrown — boot must not block on optional warmup.
   */
  warmup(): Promise<void>;
}

const debug = Debug('crowi:renderer');

/** The renderer core's own `PluginLogger` (debug-gated info, console warn/error). Exported for renderer-core work that runs outside `buildCtx` (e.g. the read-path pending redispatch in `util/page-response.ts`). */
export const coreLogger: PluginLogger = {
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

  // Phase 2 mention existence resolver — batch-checks `@username`
  // mentions against the `User` collection in a single `$in` query (no
  // per-mention N+1). `runPipeline` only invokes this in `mode: 'save'`,
  // so the resolved AST is persisted once and reused on read / view.
  // The `User` model is looked up lazily per call: `createRenderer` runs
  // during `Crowi.init` before all models are guaranteed registered.
  const resolveMentionUsernames: MentionUsernameResolver = async (usernames) => {
    if (usernames.length === 0) return new Set();
    const User = crowi.model('User') as UserModel;
    const found = await User.find({ username: { $in: usernames } })
      .select('username')
      .exec();
    return new Set(found.map((u) => u.username));
  };

  // RenderContext for the core pipeline (not for plugins). `cache` and
  // `auth` are intentionally absent — the bundled core transforms
  // (headings / wikilinks / mentions / code-blocks / syntax-highlight)
  // never consult either. The dispatch layer (embed-tags /
  // url-inline-expand) attaches a per-plugin `cache` + `auth` before
  // calling into plugin code.
  const buildCtx = (options: RunOptions): RenderContext => ({
    mode: options.mode ?? 'save',
    log: coreLogger,
    actor: options.actor,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return {
    registry,
    cache,
    async run(body, options) {
      const ctx = buildCtx(options);
      return runPipeline(body, registry, ctx, loadDeps, { cache, pageId: options.pageId ?? null, resolveMentionUsernames });
    },
    async runMetadata(body, options) {
      const result = await this.run(body, options);
      return result.metadata;
    },
    async runRender(body, options) {
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
