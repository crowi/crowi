import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Model } from 'mongoose';
import type { CollabModels, CollabRenderer } from '../models';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./mongo-sentinel') as { getSentinelPath: () => string };

/**
 * Lifecycle helpers for the collab test suites. Spins up a per-file Mongo
 * database, opens a Mongoose connection, registers the api package's model
 * factories against a minimal Crowi stub, and tears everything down on
 * teardown.
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

/**
 * The docker Mongo URI `global-setup.js` already probed for this run (see
 * that file's doc comment for the full 5-step priority order) — mirrors
 * `@crowi/api`'s `crowi-environment.js` `resolvedExternalMongoUri()`, parsing
 * the same Phase 3 / B3-2 JSON `{ strategy, uri }` sentinel record (protocol
 * parity across all three packages — `global-setup.js` writes this format
 * unconditionally, so this reader must parse it, not treat the file's
 * content as a raw URI string). This function intentionally does NOT add
 * `@crowi/api`'s B3-4 loud-warn-on-broken-sentinel refinement: any read/parse
 * failure here (missing file, invalid JSON, `CROWI_TEST_RUN_ID` itself
 * unset) is still silently treated as "fall back to `MongoMemoryServer`",
 * unchanged from this function's pre-Phase-3 behaviour — collab has no
 * equivalent reader-side requirement for the stricter assertion (only
 * `@crowi/api`'s `crowi-environment.js` does). `undefined` means no docker
 * Mongo was reachable for this run — caller falls back to
 * `MongoMemoryServer.create()`.
 */
function resolvedExternalMongoUri(): string | undefined {
  if (process.env.MONGO_URI && process.env.MONGO_URI.trim()) {
    return process.env.MONGO_URI;
  }
  try {
    const raw = readFileSync(getSentinelPath(), 'utf8').trim();
    if (!raw) return undefined;
    const record = JSON.parse(raw) as { strategy?: unknown; uri?: unknown };
    return typeof record.uri === 'string' && record.uri.trim() ? record.uri : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splice a per-file db name + `maxPoolSize=10` onto `rawUri` — the same
 * uniform splice `@crowi/api`'s `crowi-environment.js` applies (A1-3),
 * self-asserted immediately after (B3-1) so a future regression in this
 * function is caught at the point of the bug, not downstream as a mysterious
 * connection-pool-exhaustion flake. `serverSelectionTimeoutMS` /
 * `connectTimeoutMS` are deliberately left untouched — same rationale as
 * `@crowi/api`'s equivalent (this is the SAME connection every test in the
 * file reuses for its own lifetime, not a short-lived probe).
 */
function buildPerFileUri(rawUri: string, dbName: string): string {
  const url = new URL(rawUri);
  url.pathname = `/${dbName}`;
  url.searchParams.set('maxPoolSize', '10');
  const result = url.toString();
  if (new URL(result).searchParams.get('maxPoolSize') !== '10') {
    throw new Error(`[test-harness] collab test setup: failed to splice maxPoolSize=10 onto ${rawUri}`);
  }
  return result;
}

/**
 * Drop the per-file db over a short-lived, capped connection — mirrors
 * `@crowi/api`'s `crowi-environment.js` `dropPerFileDatabase()` (A1-2): drop
 * then ALWAYS close, even when the drop itself throws.
 */
async function dropPerFileDatabase(mongoUri: string): Promise<void> {
  const conn = await mongoose.createConnection(mongoUri, { maxPoolSize: 1, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    await conn.dropDatabase();
  } finally {
    await conn.close();
  }
}

/**
 * Test-only: seed a single raw document (NOT via `mongoose.model()` — that
 * would trigger autoIndex, which fire-and-forgets and can race a subsequent
 * `dropPerFileDatabase()` call; see `mongo-harness.test.ts`'s module doc
 * comment) so `mongoUri`'s db actually materializes on the server (Mongo
 * only creates a database once something is written to it).
 */
async function seedRawDocument(mongoUri: string): Promise<void> {
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  await conn.collection('probe').insertOne({ seeded: true });
  await conn.close();
}

/** Test-only: the live database catalogue on whatever server `mongoUri` points at. */
async function listDatabaseNames(mongoUri: string): Promise<string[]> {
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const db = conn.db;
    if (!db) throw new Error('connection has no db handle');
    const result = (await db.admin().command({ listDatabases: 1, nameOnly: true })) as unknown as { databases: Array<{ name: string }> };
    return result.databases.map((d) => d.name);
  } finally {
    await conn.close();
  }
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

/**
 * Despite the name (kept for the 10 existing call sites — see the module
 * doc comment above), this no longer ALWAYS spins up an in-memory server
 * (Phase 3 / B1): when `global-setup.js` found a reachable docker Mongo for
 * this run, every test file shares it (its own per-file db, exactly like
 * `@crowi/api`'s harness) instead of each file spawning its own native
 * `mongod` — `mongodb-memory-server` remains the fallback when no docker
 * Mongo is reachable for this run, unchanged from this function's
 * pre-Phase-3 behaviour.
 */
export async function startInMemoryMongo(): Promise<SmokeMongo> {
  mongoose.set('strictQuery', true);

  const dbName = `crowi_collab_test_${process.env.JEST_WORKER_ID ?? '1'}_${randomBytes(4).toString('hex')}`;

  const externalUri = resolvedExternalMongoUri();
  if (externalUri) {
    const uri = buildPerFileUri(externalUri, dbName);
    await mongoose.connect(uri);
    return {
      uri,
      async stop() {
        try {
          await dropPerFileDatabase(uri);
        } catch {
          // Best-effort — same non-fatal treatment as `@crowi/api`'s
          // `crowi-environment.js` teardown(): a stale db on the shared
          // server only costs disk until the next run drops it.
        }
        await mongoose.disconnect();
      },
    };
  }

  const memory = await MongoMemoryServer.create();
  // Splice + self-assert `maxPoolSize=10` here too (Phase 3 / B3-1) — an
  // earlier revision connected straight to `memory.getUri()`, leaving this
  // fallback path on the driver's default `maxPoolSize=100` while every
  // other path (docker autodetect / `MONGO_URI` / `TEST_MONGO_URI`) already
  // got the cap via `buildPerFileUri()` above. A per-file in-process
  // memory-server doesn't share a listen backlog with any other file, so
  // the cap isn't load-bearing here the way it is against a shared docker
  // mongod — but leaving one path uncapped is exactly the kind of drift B3-1
  // exists to catch, and consistency keeps this branch indistinguishable
  // from the others at the call site.
  const uri = buildPerFileUri(memory.getUri(), dbName);
  await mongoose.connect(uri);
  return {
    uri,
    async stop() {
      await mongoose.disconnect();
      await memory.stop();
    },
  };
}

// Test-only hooks (see `mongo-harness.test.ts`): lets that file exercise
// `buildPerFileUri` / `resolvedExternalMongoUri` / `dropPerFileDatabase`
// directly against a real docker Mongo without going through the full
// `startInMemoryMongo()` + model-registration path — same rationale as
// `packages/api/src/test/crowi-environment.js`'s `CrowiEnvironment.__test__`.
export const __test__ = { buildPerFileUri, resolvedExternalMongoUri, dropPerFileDatabase, seedRawDocument, listDatabaseNames };
