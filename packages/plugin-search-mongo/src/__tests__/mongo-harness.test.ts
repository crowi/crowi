/**
 * Deterministic coverage for `setup.ts`'s Mongo-harness internals
 * (feature-test-parallel-db-flake-hardening, Phase 3 / B1) — a deliberate
 * duplicate of `packages/collab/src/__tests__/mongo-harness.test.ts` /
 * `packages/api/src/test/crowi-environment.test.ts`'s equivalent coverage:
 *
 *   - `buildPerFileUri`: splices the per-file db name + `maxPoolSize=10`
 *     onto every resolution path's URI, and self-asserts the splice took.
 *   - `resolvedExternalMongoUri`: `MONGO_URI` env wins outright; otherwise
 *     the run-scoped sentinel (written by `global-setup.js` as a JSON
 *     `{ strategy, uri }` record, Phase 3 / B3-2 protocol parity with
 *     `@crowi/api`) is parsed and its `uri` field returned.
 *   - `dropPerFileDatabase` (the exact function `startTestMongo()`'s
 *     `stop()` calls on the docker path): drops each per-file db
 *     independently against a REAL Mongo server, seeding via
 *     `setup.ts`'s `seedRawDocument()` (a raw collection insert, NOT
 *     mongoose model registration/autoIndex — see
 *     `packages/api/src/models/page-yjs-update.test.ts:58`'s comment for
 *     why: autoIndex fire-and-forgets in the background and can otherwise
 *     re-create an emptied db after the drop). This test proves the DROP
 *     MECHANISM itself is correct, independent of that unrelated,
 *     pre-existing race.
 *
 * All Mongo access here goes through `setup.ts`'s exported `__test__`
 * hooks (never `mongoose` directly) — this file is NOT one of the
 * harness's own excluded files
 * (`src/__tests__/{setup.ts,global-setup.js,mongo-sentinel.js}` in
 * `packages/plugin-search-mongo/.eslintrc.js`), so the B1 DB-bypass lint
 * guard applies to it exactly like any other test file.
 *
 * Requires a reachable docker Mongo for this run — skips gracefully (via
 * `describe.skip`) when none is reachable, since dropping a REAL db needs a
 * REAL server.
 */
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';

import { __test__ } from './setup';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { getSentinelPath } = require('./mongo-sentinel') as { getSentinelPath: () => string };

const { buildPerFileUri, resolvedExternalMongoUri, dropPerFileDatabase, seedRawDocument, listDatabaseNames } = __test__;

// ---------------------------------------------------------------------------
// buildPerFileUri
// ---------------------------------------------------------------------------

describe('buildPerFileUri', () => {
  it('splices the per-file db name onto the pathname and adds maxPoolSize=10 when absent', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017', 'crowi_plugin_search_mongo_test_1_abcd'));
    expect(url.pathname).toBe('/crowi_plugin_search_mongo_test_1_abcd');
    expect(url.searchParams.get('maxPoolSize')).toBe('10');
  });

  it('overrides an existing maxPoolSize instead of appending a duplicate param', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017/?maxPoolSize=100', 'crowi_plugin_search_mongo_test_1_abcd'));
    expect(url.searchParams.getAll('maxPoolSize')).toEqual(['10']);
  });

  it('does not add serverSelectionTimeoutMS / connectTimeoutMS when absent from the input', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017', 'crowi_plugin_search_mongo_test_1_abcd'));
    expect(url.searchParams.has('serverSelectionTimeoutMS')).toBe(false);
    expect(url.searchParams.has('connectTimeoutMS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolvedExternalMongoUri
// ---------------------------------------------------------------------------

describe('resolvedExternalMongoUri', () => {
  const originalMongoUriEnv = process.env.MONGO_URI;
  const originalRunId = process.env.CROWI_TEST_RUN_ID;

  afterEach(() => {
    if (originalMongoUriEnv === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = originalMongoUriEnv;
    if (originalRunId === undefined) delete process.env.CROWI_TEST_RUN_ID;
    else process.env.CROWI_TEST_RUN_ID = originalRunId;
  });

  it('returns process.env.MONGO_URI when set — no sentinel read needed', () => {
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    expect(resolvedExternalMongoUri()).toBe('mongodb://example.invalid:27017/whatever');
  });

  it('returns undefined (memory-server fallback) when CROWI_TEST_RUN_ID has no sentinel file yet', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `plugin-search-mongo-harness-test-${randomBytes(4).toString('hex')}`;
    expect(resolvedExternalMongoUri()).toBeUndefined();
  });

  it('returns undefined (memory-server fallback) when CROWI_TEST_RUN_ID itself is unset — unlike @crowi/api, this package does not loud-throw on this path', () => {
    delete process.env.MONGO_URI;
    delete process.env.CROWI_TEST_RUN_ID;
    expect(resolvedExternalMongoUri()).toBeUndefined();
  });

  it('parses the JSON {strategy, uri} sentinel record global-setup.js writes and returns its uri', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `plugin-search-mongo-harness-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, JSON.stringify({ strategy: 'docker-test', uri: 'mongodb://sentinel-host:27018/?maxPoolSize=10' }));
    try {
      expect(resolvedExternalMongoUri()).toBe('mongodb://sentinel-host:27018/?maxPoolSize=10');
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it('returns undefined (memory-server fallback), not the raw sentinel content, when the sentinel is the legacy plain-URI-text format instead of JSON', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `plugin-search-mongo-harness-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, 'mongodb://legacy-plain-text-sentinel:27017/?maxPoolSize=10');
    try {
      expect(resolvedExternalMongoUri()).toBeUndefined();
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// dropPerFileDatabase (the exact function `startTestMongo()`'s `stop()`
// calls on the docker path)
// ---------------------------------------------------------------------------

// This ambient run's own resolved Mongo URI (via the sentinel this
// package's OWN `global-setup.js` already wrote for this run) — reuses the
// already-imported `resolvedExternalMongoUri` (same function the describe
// block above exercises directly) rather than re-deriving the same
// MONGO_URI-then-sentinel lookup a second time, so this test works whether
// the ambient run took the docker or the memory-server path.
const dockerUri = resolvedExternalMongoUri();
const describeIfDocker = dockerUri ? describe : describe.skip;

describeIfDocker('dropPerFileDatabase', () => {
  function uriForDb(dbName: string): string {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const url = new URL(dockerUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  }

  it('drops each per-file db independently across consecutive same-worker stop() calls', async () => {
    const dbA = `crowi_plugin_search_mongo_test_harness_probe_a_${randomBytes(4).toString('hex')}`;
    const dbB = `crowi_plugin_search_mongo_test_harness_probe_b_${randomBytes(4).toString('hex')}`;

    await seedRawDocument(uriForDb(dbA));
    await seedRawDocument(uriForDb(dbB));

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const before = await listDatabaseNames(dockerUri!);
    expect(before).toEqual(expect.arrayContaining([dbA, dbB]));

    await dropPerFileDatabase(uriForDb(dbA));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const afterDroppingA = await listDatabaseNames(dockerUri!);
    expect(afterDroppingA).not.toContain(dbA);
    expect(afterDroppingA).toContain(dbB); // B is untouched by A's drop

    await dropPerFileDatabase(uriForDb(dbB));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const afterDroppingB = await listDatabaseNames(dockerUri!);
    expect(afterDroppingB).not.toContain(dbB);
  });
});
