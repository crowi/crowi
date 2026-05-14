import type { Model } from 'mongoose';
import Debug from 'debug';
import { resolveApiDistFile } from './api-dist';

const debug = Debug('crowi:collab:models');

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
  getRenderer(): never;
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
      throw new Error('[crowi:collab] crowi.getRenderer() is not available in the collab process; renderer-bound code paths must run in @crowi/api.');
    },
  };
};

/**
 * The subset of Mongoose models the collab hooks reach for. Exposed as
 * a typed bag so call sites don't string-lookup at hot path.
 */
export interface CollabModels {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Page: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Revision: Model<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PageYjsUpdate: Model<any>;
}

interface ApiModelFactoryModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (crowi: unknown) => Model<any>;
}

interface ApiPaths {
  pageJs: string;
  revisionJs: string;
  pageYjsUpdateJs: string;
}

const resolveApiModelPaths = (): ApiPaths => ({
  pageJs: resolveApiDistFile('models/page.js'),
  revisionJs: resolveApiDistFile('models/revision.js'),
  pageYjsUpdateJs: resolveApiDistFile('models/page-yjs-update.js'),
});

/**
 * Resolve @crowi/api model factories, invoke them with the minimal
 * crowi stub, and return the resulting Mongoose models. Throws when
 * @crowi/api can't be located so the bootstrap fails fast with a
 * descriptive error instead of an opaque `mongoose.model is not a
 * function` later on.
 *
 * Must be called **after** `connectMongo()` — Mongoose's
 * `model()` call inside the factories binds the schema to the active
 * connection.
 */
export function registerModels(): CollabModels {
  const paths = resolveApiModelPaths();
  debug('resolving @crowi/api models from %s', paths.pageJs);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pageMod = require(paths.pageJs) as ApiModelFactoryModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const revisionMod = require(paths.revisionJs) as ApiModelFactoryModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pageYjsUpdateMod = require(paths.pageYjsUpdateJs) as ApiModelFactoryModule;

  // Order matters: Page's factory registers schema.statics that reach
  // for `crowi.model('Revision')` via the stub above. Mongoose only
  // throws on that lookup when the static is invoked (not at definition
  // time) but we still register Revision first as a defensive measure.
  const stub = makeCrowiStub();
  const Revision = revisionMod.default(stub);
  const Page = pageMod.default(stub);
  const PageYjsUpdate = pageYjsUpdateMod.default(stub);

  debug('models registered: Page, Revision, PageYjsUpdate');
  return { Page, Revision, PageYjsUpdate };
}
