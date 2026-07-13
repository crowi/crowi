import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./mongo-sentinel') as { getSentinelPath: () => string };

/**
 * Lifecycle helper for `driver.test.ts` (feature-test-parallel-db-flake-hardening
 * Phase 3 / B1) — the sole window this package's tests use to reach Mongo,
 * mirroring `packages/collab/src/__tests__/setup.ts`'s `startInMemoryMongo()`
 * design (itself mirroring `packages/api/src/test/crowi-environment.js`).
 * Before this, `driver.test.ts` called `MongoMemoryServer.create()` /
 * `mongoose.connect()` directly; centralizing it here means B1's lint guard
 * (`packages/plugin-search-mongo/.eslintrc.js`) can exclude just this ONE
 * file instead of every test file this package will ever have.
 */
export interface TestMongo {
  stop(): Promise<void>;
}

/**
 * The docker Mongo URI `global-setup.js` already probed for this run — see
 * that file's doc comment for the full 5-step priority order. Parses the
 * Phase 3 / B3-2 JSON `{ strategy, uri }` sentinel record `global-setup.js`
 * writes unconditionally (protocol parity with `@crowi/api` and
 * `@crowi/collab` — see that file's `writeSentinel()` doc comment); any
 * read/parse failure is silently treated as "nothing reachable", same as
 * `@crowi/collab`'s equivalent (no B3-4-style loud warn here — see that
 * package's `setup.ts` doc comment for why). `undefined` means no docker
 * Mongo was reachable for this run; caller falls back to
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
 * Splice a per-file db name + `maxPoolSize=10` onto `rawUri`, self-asserted
 * immediately after (Phase 3 / B3-1) — same uniform splice + self-check
 * `@crowi/api`'s `crowi-environment.js` and `@crowi/collab`'s `setup.ts`
 * apply.
 */
function buildPerFileUri(rawUri: string, dbName: string): string {
  const url = new URL(rawUri);
  url.pathname = `/${dbName}`;
  url.searchParams.set('maxPoolSize', '10');
  const result = url.toString();
  if (new URL(result).searchParams.get('maxPoolSize') !== '10') {
    throw new Error(`[test-harness] plugin-search-mongo test setup: failed to splice maxPoolSize=10 onto ${rawUri}`);
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
 * `dropPerFileDatabase()` call) so `mongoUri`'s db actually materializes.
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

/**
 * Connects the default mongoose connection to either the docker Mongo
 * `global-setup.js` already resolved for this run (own per-file db,
 * dropped on `stop()`) or, when none is reachable, a fresh per-file
 * `mongodb-memory-server` (unchanged pre-Phase-3 fallback behaviour).
 */
export async function startTestMongo(): Promise<TestMongo> {
  mongoose.set('strictQuery', true);

  const dbName = `crowi_plugin_search_mongo_test_${process.env.JEST_WORKER_ID ?? '1'}_${randomBytes(4).toString('hex')}`;

  const externalUri = resolvedExternalMongoUri();
  if (externalUri) {
    const uri = buildPerFileUri(externalUri, dbName);
    await mongoose.connect(uri);
    return {
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
  // Splice + self-assert `maxPoolSize=10` here too (Phase 3 / B3-1) — see
  // `packages/collab/src/__tests__/setup.ts`'s equivalent doc comment for
  // why this fallback path must not be the one path left uncapped.
  const uri = buildPerFileUri(memory.getUri(), dbName);
  await mongoose.connect(uri);
  return {
    async stop() {
      await mongoose.disconnect();
      await memory.stop();
    },
  };
}

// Test-only hooks (see `mongo-harness.test.ts`): lets that file exercise
// these internals directly against a real docker Mongo without going
// through the full `startTestMongo()` path — same rationale as
// `packages/collab/src/__tests__/setup.ts`'s `__test__` export.
export const __test__ = { buildPerFileUri, resolvedExternalMongoUri, dropPerFileDatabase, seedRawDocument, listDatabaseNames };
