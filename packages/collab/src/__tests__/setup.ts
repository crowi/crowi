import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Model } from 'mongoose';
import type { CollabModels, CollabRenderer } from '../models';

/**
 * Lifecycle helpers for the collab test suites. Spins up an isolated
 * MongoDB-in-memory instance, opens a Mongoose connection, registers
 * the api package's model factories against a minimal Crowi stub,
 * and tears everything down on teardown.
 *
 * The api-dist resolution lives here (test-only) on purpose. Production
 * collab boot path no longer requires `@crowi/api` — `attachCollabServer`
 * receives already-built models from the host api process. Keeping the
 * dist-resolve helper inside `__tests__/` means the `library` shipped to
 * runtime is api-clean, while jest still gets a fully-wired model bag
 * to exercise hook + save-flow behaviour.
 */
export interface SmokeMongo {
  uri: string;
  stop(): Promise<void>;
}

interface ModelFactoryModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (crowi: unknown) => Model<any>;
}

interface ApiRendererModule {
  createRenderer(crowi: unknown): CollabRenderer;
}

/**
 * Resolve a path inside `@crowi/api/dist/...` without triggering the
 * api package's default export (`dist/app.js`), which would auto-boot
 * the Express server. Same pattern the pre-Phase-9 `api-dist.ts`
 * helper used; preserved here because the test suite is the only
 * remaining caller.
 */
function resolveApiDistFile(relPath: string): string {
  const apiPkgPath = require.resolve('@crowi/api/package.json', { paths: [process.cwd(), __dirname] });
  return path.join(path.dirname(apiPkgPath), 'dist', relPath);
}

/**
 * Stand-in for `events/page.ts`'s `PageEvent`. The Page factory wires
 * `pageEvent.on('create', pageEvent.onCreate)` and siblings at
 * definition time; storing them as no-ops is safe because the test
 * harness never persists pages from a path that emits to listeners
 * (search indexing / backlink registration belongs to the api process
 * in production).
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

interface CrowiStub {
  event(name: string): NoopPageEvent;
  model(name: string): unknown;
  getRenderer(): CollabRenderer;
  _setRenderer(renderer: CollabRenderer): void;
}

const makeCrowiStub = (): CrowiStub => {
  let renderer: CollabRenderer | null = null;
  return {
    event: () => makeNoopPageEvent(),
    model: (name) => mongoose.model(name),
    getRenderer: () => {
      if (!renderer) {
        throw new Error('[crowi:collab:tests] renderer not initialised — wire models before invoking renderer-dependent statics.');
      }
      return renderer;
    },
    _setRenderer(r) {
      renderer = r;
    },
  };
};

export interface RegisterTestModelsResult {
  models: CollabModels;
  renderer: CollabRenderer;
}

/**
 * Build api-side Mongoose models + a renderer against an internal
 * Crowi stub. Mirrors what the api process does during boot
 * (`setupModels` + `setupRenderer`) but without the encryption /
 * config / plugin pipeline — collab tests don't need those.
 *
 * Must be called **after** `startInMemoryMongo()` so the model
 * factories bind their schemas to the active Mongoose connection.
 */
export function registerTestModels(): RegisterTestModelsResult {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const pageMod = require(resolveApiDistFile('models/page.js')) as ModelFactoryModule;
  const revisionMod = require(resolveApiDistFile('models/revision.js')) as ModelFactoryModule;
  const pageYjsUpdateMod = require(resolveApiDistFile('models/page-yjs-update.js')) as ModelFactoryModule;
  const userMod = require(resolveApiDistFile('models/user.js')) as ModelFactoryModule;
  const pluginRenderCacheMod = require(resolveApiDistFile('models/plugin-render-cache.js')) as ModelFactoryModule;
  const rendererMod = require(resolveApiDistFile('renderer/index.js')) as ApiRendererModule;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const stub = makeCrowiStub();
  const Revision = revisionMod.default(stub);
  const Page = pageMod.default(stub);
  const PageYjsUpdate = pageYjsUpdateMod.default(stub);
  const User = userMod.default(stub);
  const PluginRenderCache = pluginRenderCacheMod.default(stub);

  const renderer = rendererMod.createRenderer(stub as unknown as never);
  stub._setRenderer(renderer);

  return {
    models: { Page, Revision, PageYjsUpdate, User, PluginRenderCache },
    renderer,
  };
}

export async function startInMemoryMongo(): Promise<SmokeMongo> {
  const memory = await MongoMemoryServer.create();
  const uri = memory.getUri();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  return {
    uri,
    async stop() {
      await mongoose.disconnect();
      await memory.stop();
    },
  };
}
