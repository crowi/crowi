import type { Model } from 'mongoose';

/**
 * Renderer surface the collab save flow needs to call
 * `Revision.prepareRevision`. Structurally compatible with
 * `@crowi/api`'s `Renderer` interface — kept loose here so consumers
 * can pass either the api's `Renderer` instance verbatim or a stub
 * (test fixtures, future alternate runtimes) without coupling the
 * collab library to the api package's TS surface.
 */
export interface CollabRenderer {
  runRender(body: string, options?: { mode?: string; pageId?: string }): Promise<{ metadata: unknown; renderedAst: unknown }>;
  warmup?: () => Promise<void>;
}

/**
 * The subset of Mongoose models the collab hooks reach for. Exposed as
 * a typed bag so call sites don't string-lookup at hot path. `User` +
 * `PluginRenderCache` are wired because `Revision.prepareRevision` and
 * `createRenderer` look them up at runtime / construction time.
 *
 * After the RFC-0003 Phase 9 same-process attach work, the api process
 * builds these models in its own boot sequence (`Crowi.setupModels`)
 * and hands the bag to `attachCollabServer` — there is no longer any
 * `api-dist` / `createRequire` ceremony inside this package.
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
