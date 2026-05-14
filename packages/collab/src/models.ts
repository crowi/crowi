import type { Model } from 'mongoose';
import Debug from 'debug';
import { resolveApiDistFile } from './api-dist';

const debug = Debug('crowi:collab:models');

/**
 * Renderer surface the collab process needs to call
 * `Revision.prepareRevision`. Strucutrally compatible with
 * `@crowi/api`'s `Renderer` interface — kept loose here so we don't
 * have to import the full type and force a build-time edge into the
 * collab package.
 */
export interface CollabRenderer {
  runRender(body: string, options?: { mode?: string; pageId?: string }): Promise<{ metadata: unknown; renderedAst: unknown }>;
  // Used by the api side; not required from collab but kept on the
  // type so the dist re-export stays one-to-one.
  warmup?: () => Promise<void>;
}

/**
 * The collab process re-uses @crowi/api's Mongoose model factories so
 * schemas (and any future statics / instance methods) cannot drift
 * between the two processes. Resolving via `require.resolve` mirrors
 * the admin-cli pattern (see
 * `packages/admin-cli/src/commands/storage-copy.ts:loadApi`):
 *
 *   1. `require.resolve('@crowi/api/package.json', { paths: [...] })`
 *      finds the workspace-symlinked api package (dev) or the npm-
 *      installed copy (prod) without triggering `@crowi/api`'s default
 *      export (`dist/app.js`) which auto-boots the Express server.
 *
 *   2. We dive into `dist/models/*` directly. The api build runs
 *      `tsc + tsc-alias`, so `src/` path aliases are already resolved
 *      inside `dist/` — no module-alias registration needed at
 *      runtime.
 *
 *   3. Model factories have signature `(crowi: Crowi) => Model`. The
 *      Page factory calls `crowi.event('Page')` at definition time
 *      (events/page.ts wires backlink / search indexing listeners),
 *      and the Revision factory uses `crowi.getRenderer()` inside
 *      `prepareRevision` (not called from collab). For collab's
 *      read-mostly workload we supply a **minimal stub** that returns a
 *      no-op event emitter from `.event()` — collab does **not** fan
 *      out page events (search indexing / backlink registration is
 *      strictly the api process's job).
 *
 *   4. Mongoose's global model registry (`mongoose.model(name)`) is
 *      shared between collab and any in-process clients. The hooks
 *      look the models up via the returned object so we avoid the
 *      string-key registry lookup at hot path.
 */

interface ApiCrowiStub {
  event(name: string): NoopPageEvent;
  model(name: string): unknown;
  getRenderer(): CollabRenderer;
  /**
   * Phase 5: a slot for an externally-built renderer instance. We
   * defer construction until **after** all models are registered (the
   * api side's `createRenderer` calls `crowi.model('PluginRenderCache')`
   * eagerly), then write into this field so the same stub can be
   * passed back to model factories that internally call
   * `crowi.getRenderer()` from instance / static methods.
   */
  _setRenderer(renderer: CollabRenderer): void;
}

/**
 * Stand-in for `events/page.ts`'s `PageEvent`. Provides the listener
 * registration hooks the Page factory wires at definition time
 * (`pageEvent.on('create', pageEvent.onCreate)` and siblings) and the
 * referenced handler methods. Storing them as no-ops is safe because
 * the collab process never persists pages — write paths that would
 * `emit('update')` (e.g. `Page.updatePage`) are exclusively reached
 * from the api process.
 */
interface NoopPageEvent {
  on(event: string, listener: (...args: unknown[]) => void): NoopPageEvent;
  emit(event: string, ...args: unknown[]): boolean;
  onCreate(...args: unknown[]): void;
  onUpdate(...args: unknown[]): void;
  onDelete(...args: unknown[]): void;
}

const makeNoopPageEvent = (): NoopPageEvent => {
  const noop = (): void => undefined;
  const event: NoopPageEvent = {
    on: () => event,
    emit: () => false,
    onCreate: noop,
    onUpdate: noop,
    onDelete: noop,
  };
  return event;
};

/**
 * Surface contract: as of Phase 3, the api-side factory `default(crowi)`
 * functions reach for exactly **one** `crowi.*` method at definition
 * time — `crowi.event('Page')` (Page factory wires backlink / search
 * listeners). All `crowi.model('User')` / `crowi.getRenderer()` /
 * other accesses happen inside statics or instance methods that collab
 * never invokes (those run only through the api process).
 *
 * If a future phase makes the factories use additional `crowi.*` at
 * definition time, this stub will throw at boot — fail-fast surfaces
 * the regression instead of silently producing broken models. Update
 * `makeCrowiStub` here and add the method to `ApiCrowiStub` when that
 * happens, or consider Option B (extract models into `@crowi/models`).
 */
const makeCrowiStub = (): ApiCrowiStub => {
  let renderer: CollabRenderer | null = null;
  return {
    event: () => makeNoopPageEvent(),
    model: (name) => {
      // Re-export through the shared mongoose registry so cross-model
      // statics (`crowi.model('User')` etc.) resolve once registerModels
      // has run.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mongoose = require('mongoose') as typeof import('mongoose');
      return mongoose.model(name);
    },
    getRenderer: () => {
      if (!renderer) {
        // Phase 5: indicates `registerRenderer` was never wired before
        // a save tried to call `prepareRevision`. Surfaces as a save
        // error to the client (caught by save-flow.ts) rather than
        // crashing the process.
        throw new Error('[crowi:collab] renderer not initialised — call registerRenderer() after registerModels().');
      }
      return renderer;
    },
    _setRenderer(r) {
      renderer = r;
    },
  };
};

/**
 * The subset of Mongoose models the collab hooks reach for. Exposed as
 * a typed bag so call sites don't string-lookup at hot path. `User` +
 * `PluginRenderCache` are wired because `Revision.prepareRevision` and
 * `createRenderer` look them up at runtime / construction time.
 */
export interface CollabModels {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Page: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Revision: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PageYjsUpdate: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  User: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PluginRenderCache: Model<any>;
}

interface ApiModelFactoryModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (crowi: unknown) => Model<any>;
}

interface ApiPaths {
  pageJs: string;
  revisionJs: string;
  pageYjsUpdateJs: string;
  userJs: string;
  pluginRenderCacheJs: string;
}

const resolveApiModelPaths = (): ApiPaths => ({
  pageJs: resolveApiDistFile('models/page.js'),
  revisionJs: resolveApiDistFile('models/revision.js'),
  pageYjsUpdateJs: resolveApiDistFile('models/page-yjs-update.js'),
  userJs: resolveApiDistFile('models/user.js'),
  pluginRenderCacheJs: resolveApiDistFile('models/plugin-render-cache.js'),
});

interface ApiRendererModule {
  createRenderer(crowi: unknown): CollabRenderer;
}

/**
 * Result of `registerModels`. Renderer is constructed inline so the
 * Crowi stub is wired before it leaves this module; callers never see
 * the stub. Plugin transforms are **not** loaded (the collab process
 * never runs `PluginManager.bootstrap()`) — the bundled core 5
 * transforms still execute, which keeps `Revision.meta` in sync with
 * the api side. RFC-0002's stale-version fallback re-renders missing
 * plugin output on the api read path; see Phase 5 architecturalNote
 * "collab 側 renderer".
 */
export interface RegisterModelsResult {
  models: CollabModels;
  renderer: CollabRenderer;
}

/**
 * Resolve @crowi/api model factories + the renderer, wire them
 * against an internal Crowi stub, and return the result. Throws when
 * @crowi/api can't be located so bootstrap fails fast with a
 * descriptive error instead of an opaque `mongoose.model is not a
 * function` later on.
 *
 * Must be called **after** `connectMongo()` — Mongoose's `model()`
 * call inside the factories binds the schema to the active connection.
 */
export function registerModels(): RegisterModelsResult {
  const paths = resolveApiModelPaths();
  debug('resolving @crowi/api models from %s', paths.pageJs);

  /* eslint-disable @typescript-eslint/no-var-requires */
  const pageMod = require(paths.pageJs) as ApiModelFactoryModule;
  const revisionMod = require(paths.revisionJs) as ApiModelFactoryModule;
  const pageYjsUpdateMod = require(paths.pageYjsUpdateJs) as ApiModelFactoryModule;
  const userMod = require(paths.userJs) as ApiModelFactoryModule;
  const pluginRenderCacheMod = require(paths.pluginRenderCacheJs) as ApiModelFactoryModule;
  const rendererMod = require(resolveApiDistFile('renderer/index.js')) as ApiRendererModule;
  /* eslint-enable @typescript-eslint/no-var-requires */

  // Order matters: Page's factory registers schema.statics that reach
  // for `crowi.model('Revision')` via the stub. Mongoose only throws on
  // that lookup when the static is invoked (not at definition time) but
  // we still register Revision first as a defensive measure. User /
  // PluginRenderCache are independent and follow.
  const stub = makeCrowiStub();
  const Revision = revisionMod.default(stub);
  const Page = pageMod.default(stub);
  const PageYjsUpdate = pageYjsUpdateMod.default(stub);
  const User = userMod.default(stub);
  const PluginRenderCache = pluginRenderCacheMod.default(stub);

  // Build the renderer against the same stub the model statics close
  // over — `createRenderer(stub)` reaches for `crowi.model('PluginRenderCache')`
  // through the stub, which resolves via the Mongoose registry we just
  // populated. Plugging it back into the stub before returning means
  // `crowi.getRenderer()` (called from `Revision.prepareRevision`)
  // can never observe a `null` slot.
  const renderer = rendererMod.createRenderer(stub as unknown as never);
  stub._setRenderer(renderer);

  debug('models + renderer registered (core transforms only; plugins not loaded)');
  return {
    models: { Page, Revision, PageYjsUpdate, User, PluginRenderCache },
    renderer,
  };
}
