/**
 * Deterministic + integration coverage for `crowi-environment.js`
 * (feature-test-parallel-db-flake-hardening, Phase 1 + Phase 3):
 *
 *   - `buildPerFileUri`: `maxPoolSize=10` is spliced onto every resolution
 *     path's URI, `serverSelectionTimeoutMS`/`connectTimeoutMS` are left
 *     alone either way (A1-3), and the splice self-asserts before returning
 *     (B3-1, exercised directly below via `assertMaxPoolSizeSpliced`).
 *   - `resolvedExternalMongoUri`: the run-scoped sentinel is now read and
 *     validated as a JSON `{ strategy, uri }` record (B3-2) on EVERY branch
 *     WITHOUT EXCEPTION — including when `MONGO_URI` is set (Phase 3
 *     rework), which still wins the return value outright but no longer
 *     skips validating its own run's sentinel first. An unset
 *     `CROWI_TEST_RUN_ID` still throws loudly (A1-4), and a sentinel that
 *     exists but can't be parsed into a `strategy` now warns loudly (B3-4)
 *     instead of silently falling back, on every branch; a legitimately
 *     recorded `memory-server` strategy does NOT warn (that's a resolved
 *     outcome, not a broken sentinel).
 *   - `assertMaxPoolSizeSpliced` (B3-1): the exact self-check
 *     `buildPerFileUri` runs post-splice, exercised directly so a future
 *     regression in the splice logic shows up as a targeted failure here.
 *   - `dropPerFileDatabase` (the exact function `teardown()` calls): drops
 *     each per-file db independently against a REAL Mongo server — reusing
 *     this file's own ambient connection (`MONGO_URI`, set by this very
 *     module's `setup()` for the file we're running in) so the test works
 *     whether the ambient run took the docker or the memory-server path
 *     (A1-2).
 *
 * `crowi-environment.js` is required directly (not imported) because it's
 * plain CJS with no type declarations; its test-only hooks are attached as
 * static properties on the exported class (`.__test__`) rather than
 * separate named exports — see that file's bottom comment for why.
 */
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';

import mongoose from 'mongoose';

import { GLOBAL_KEY as RING_BUFFER_GLOBAL_KEY_FROM_OP_RING_BUFFER } from './op-ring-buffer';
import { MONGO_URI } from './setup';

// `crowi-environment.js` / `test-mongo-sentinel.js` are plain CJS with no
// type declarations — required directly rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CrowiEnvironment = require('./crowi-environment');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./test-mongo-sentinel');

const {
  buildPerFileUri,
  resolvedExternalMongoUri,
  dropPerFileDatabase,
  assertMaxPoolSizeSpliced,
  classifyPortClass,
  classifyOpContext,
  testFullNameFromCircusNode,
  buildWorkerEnrichmentRecord,
  RING_BUFFER_GLOBAL_KEY,
} = CrowiEnvironment.__test__ as {
  buildPerFileUri: (rawUri: string, dbName: string) => string;
  resolvedExternalMongoUri: () => string | undefined;
  dropPerFileDatabase: (mongoUri: string) => Promise<void>;
  assertMaxPoolSizeSpliced: (uri: string) => void;
  classifyPortClass: (hostPort: { host: string; port: number } | null, resolvedMongoUri: string | undefined) => 'mongo' | 'ephemeral' | 'other' | null;
  classifyOpContext: (input: {
    errorMessages: string[];
    recentOps: Array<{ method: string; path: string; httpStatus: number | null; testFullName: string | null }>;
    testFullName: string | null;
    resolvedMongoUri: string | undefined;
  }) => { operationKind: string; httpStatus: number | null; httpMethod: string | null; httpPath: string | null; portClass: string | null; dispatched: boolean };
  testFullNameFromCircusNode: (node: any) => string | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  buildWorkerEnrichmentRecord: (event: any, state: any, workerContext: any) => Record<string, unknown> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  RING_BUFFER_GLOBAL_KEY: string;
};

// ---------------------------------------------------------------------------
// buildPerFileUri
// ---------------------------------------------------------------------------

describe('buildPerFileUri', () => {
  it('splices the per-file db name onto the pathname and adds maxPoolSize=10 when absent', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017', 'crowi_test_1_abcd'));
    expect(url.pathname).toBe('/crowi_test_1_abcd');
    expect(url.searchParams.get('maxPoolSize')).toBe('10');
  });

  it('overrides an existing maxPoolSize instead of appending a duplicate param (CI-style / TEST_MONGO_URI-style override)', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017/?maxPoolSize=100', 'crowi_test_1_abcd'));
    expect(url.searchParams.getAll('maxPoolSize')).toEqual(['10']);
  });

  it('preserves other query params untouched', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017/?replicaSet=rs0', 'crowi_test_1_abcd'));
    expect(url.searchParams.get('replicaSet')).toBe('rs0');
    expect(url.searchParams.get('maxPoolSize')).toBe('10');
  });

  it('does not add serverSelectionTimeoutMS / connectTimeoutMS when absent from the input', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017', 'crowi_test_1_abcd'));
    expect(url.searchParams.has('serverSelectionTimeoutMS')).toBe(false);
    expect(url.searchParams.has('connectTimeoutMS')).toBe(false);
  });

  it('leaves serverSelectionTimeoutMS / connectTimeoutMS untouched when present on the input', () => {
    const url = new URL(buildPerFileUri('mongodb://localhost:27017/?serverSelectionTimeoutMS=1234&connectTimeoutMS=5678', 'crowi_test_1_abcd'));
    expect(url.searchParams.get('serverSelectionTimeoutMS')).toBe('1234');
    expect(url.searchParams.get('connectTimeoutMS')).toBe('5678');
  });

  it('works against a memory-server-shaped URI (random host:port, no query string)', () => {
    const url = new URL(buildPerFileUri('mongodb://127.0.0.1:52341/', 'crowi_test_1_abcd'));
    expect(url.pathname).toBe('/crowi_test_1_abcd');
    expect(url.searchParams.get('maxPoolSize')).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// resolvedExternalMongoUri
// ---------------------------------------------------------------------------

describe('resolvedExternalMongoUri', () => {
  const originalMongoUriEnv = process.env.MONGO_URI;
  const originalRunId = process.env.CROWI_TEST_RUN_ID;

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalMongoUriEnv === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = originalMongoUriEnv;
    if (originalRunId === undefined) delete process.env.CROWI_TEST_RUN_ID;
    else process.env.CROWI_TEST_RUN_ID = originalRunId;
  });

  it('returns process.env.MONGO_URI when set and this run has a well-formed env-override sentinel record — no B3-4 warn', () => {
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    const sentinelPath = getSentinelPath();
    // Mirrors what `global-setup.js`'s MONGO_URI branch now records (Phase 3
    // rework) — this function reads + validates it (unconditionally, even
    // on this branch) before returning process.env.MONGO_URI regardless.
    writeFileSync(sentinelPath, JSON.stringify({ strategy: 'env-override', uri: process.env.MONGO_URI }));
    try {
      expect(resolvedExternalMongoUri()).toBe('mongodb://example.invalid:27017/whatever');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it("still returns process.env.MONGO_URI when set even if this run's OWN sentinel is broken/missing — but warns about the broken sentinel (Phase 3 rework: MONGO_URI no longer skips the sentinel read)", () => {
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    // Deliberately do NOT write a sentinel file for this run id — simulates
    // global-setup.js having failed to write (or not having run at all).
    expect(resolvedExternalMongoUri()).toBe('mongodb://example.invalid:27017/whatever');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('[test-harness] '));
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('could not determine'));
  });

  it('throws a diagnostic error (does not silently fall back) when MONGO_URI is unset and CROWI_TEST_RUN_ID never propagated', () => {
    delete process.env.MONGO_URI;
    delete process.env.CROWI_TEST_RUN_ID;
    expect(() => resolvedExternalMongoUri()).toThrow(/CROWI_TEST_RUN_ID is unset/);
  });

  it('throws even when MONGO_URI IS set, if CROWI_TEST_RUN_ID never propagated — the worker-level run-id assertion applies to every resolution path, including CI (which always sets MONGO_URI via services.mongo)', () => {
    process.env.MONGO_URI = 'mongodb://example.invalid:27017/whatever';
    delete process.env.CROWI_TEST_RUN_ID;
    expect(() => resolvedExternalMongoUri()).toThrow(/CROWI_TEST_RUN_ID is unset/);
  });

  it('(B3-4) warns loudly and falls back to undefined when CROWI_TEST_RUN_ID is set but no sentinel file exists yet for it — a broken-harness signal, not a silent fallback', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    expect(resolvedExternalMongoUri()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('[test-harness] '));
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('could not determine'));
  });

  it('(B3-4) warns loudly and falls back to undefined when the sentinel exists but is not valid JSON (a broken/corrupt sentinel, not the legacy plain-URI format)', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, 'mongodb://sentinel-host:27017/?maxPoolSize=10');
    try {
      expect(resolvedExternalMongoUri()).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('not valid JSON'));
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it('(B3-4) warns loudly when the sentinel is a blank file (broken — every branch, including MONGO_URI, always writes a non-empty JSON record)', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, '');
    try {
      expect(resolvedExternalMongoUri()).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('was empty'));
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it('returns the resolved URI from a JSON {strategy, uri} sentinel record — WITHOUT warning (docker-test strategy)', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, JSON.stringify({ strategy: 'docker-test', uri: 'mongodb://sentinel-host:27017/?maxPoolSize=10' }));
    try {
      expect(resolvedExternalMongoUri()).toBe('mongodb://sentinel-host:27017/?maxPoolSize=10');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it('a legitimately recorded `memory-server` strategy (uri: null) returns undefined WITHOUT warning — NOT the same as an unreadable sentinel', () => {
    delete process.env.MONGO_URI;
    process.env.CROWI_TEST_RUN_ID = `crowi-environment-test-${randomBytes(4).toString('hex')}`;
    const sentinelPath = getSentinelPath();
    writeFileSync(sentinelPath, JSON.stringify({ strategy: 'memory-server', uri: null }));
    try {
      expect(resolvedExternalMongoUri()).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// assertMaxPoolSizeSpliced (Phase 3 / B3-1 post-splice self-check)
// ---------------------------------------------------------------------------

describe('assertMaxPoolSizeSpliced', () => {
  it('does not throw when maxPoolSize=10 is present', () => {
    expect(() => assertMaxPoolSizeSpliced('mongodb://localhost:27017/?maxPoolSize=10')).not.toThrow();
  });

  it('throws when maxPoolSize is missing entirely (splice-logic regression)', () => {
    expect(() => assertMaxPoolSizeSpliced('mongodb://localhost:27017/crowi_test_1_abcd')).toThrow(/maxPoolSize/);
  });

  it('throws when maxPoolSize is present but not 10 (splice-logic regression, e.g. the driver default of 100 leaked through)', () => {
    expect(() => assertMaxPoolSizeSpliced('mongodb://localhost:27017/?maxPoolSize=100')).toThrow(/maxPoolSize/);
  });
});

// ---------------------------------------------------------------------------
// dropPerFileDatabase (the exact function teardown() calls)
// ---------------------------------------------------------------------------

describe('dropPerFileDatabase', () => {
  function uriForDb(dbName: string): string {
    const url = new URL(MONGO_URI);
    url.pathname = `/${dbName}`;
    return url.toString();
  }

  async function seedDatabase(dbName: string): Promise<void> {
    // Mongo only materializes a database once something is written to it.
    const conn = await mongoose.createConnection(uriForDb(dbName)).asPromise();
    await conn.collection('probe').insertOne({ seeded: true });
    await conn.close();
  }

  async function listDatabaseNames(): Promise<string[]> {
    const conn = await mongoose.createConnection(MONGO_URI).asPromise();
    try {
      const db = conn.db;
      if (!db) throw new Error('connection has no db handle');
      const result = (await db.admin().command({ listDatabases: 1, nameOnly: true })) as unknown as { databases: Array<{ name: string }> };
      return result.databases.map((d) => d.name);
    } finally {
      await conn.close();
    }
  }

  it('drops each per-file db independently across consecutive same-worker teardown() calls', async () => {
    const dbA = `crowi_test_teardown_probe_a_${randomBytes(4).toString('hex')}`;
    const dbB = `crowi_test_teardown_probe_b_${randomBytes(4).toString('hex')}`;

    await seedDatabase(dbA);
    await seedDatabase(dbB);

    const before = await listDatabaseNames();
    expect(before).toEqual(expect.arrayContaining([dbA, dbB]));

    // Sequential calls, same as two test files' teardown() running one
    // after another inside a single jest worker process.
    await dropPerFileDatabase(uriForDb(dbA));
    const afterDroppingA = await listDatabaseNames();
    expect(afterDroppingA).not.toContain(dbA);
    expect(afterDroppingA).toContain(dbB); // B is untouched by A's drop

    await dropPerFileDatabase(uriForDb(dbB));
    const afterDroppingB = await listDatabaseNames();
    expect(afterDroppingB).not.toContain(dbB);
  });
});

// ---------------------------------------------------------------------------
// classifyPortClass (feature-flake-failure-taxonomy AC-3)
// ---------------------------------------------------------------------------

describe('classifyPortClass', () => {
  const resolvedMongoUri = 'mongodb://localhost:27018/crowi_test_1_abcd?maxPoolSize=10';

  it('returns null when there is no host:port evidence at all', () => {
    expect(classifyPortClass(null, resolvedMongoUri)).toBeNull();
  });

  it('classifies a host:port matching the resolved Mongo URI as "mongo" — never a hardcoded 27017/27018 check', () => {
    expect(classifyPortClass({ host: 'localhost', port: 27018 }, resolvedMongoUri)).toBe('mongo');
  });

  it('classifies a Mongo match even when the resolved URI uses a dynamic memory-server port (not 27017/27018)', () => {
    expect(classifyPortClass({ host: '127.0.0.1', port: 52341 }, 'mongodb://127.0.0.1:52341/crowi_test_1_abcd?maxPoolSize=10')).toBe('mongo');
  });

  it('treats "localhost" and "127.0.0.1" as the same host for the Mongo comparison', () => {
    expect(classifyPortClass({ host: '127.0.0.1', port: 27018 }, resolvedMongoUri)).toBe('mongo');
  });

  it('classifies a loopback host:port that does NOT match the resolved Mongo URI as "ephemeral" (Supertest\'s own local server)', () => {
    expect(classifyPortClass({ host: '127.0.0.1', port: 54321 }, resolvedMongoUri)).toBe('ephemeral');
  });

  it('classifies a non-loopback host that also is not Mongo as "other"', () => {
    expect(classifyPortClass({ host: 'example.invalid', port: 443 }, resolvedMongoUri)).toBe('other');
  });

  it('falls through to loopback/other classification instead of throwing when resolvedMongoUri is unparsable', () => {
    expect(classifyPortClass({ host: '127.0.0.1', port: 54321 }, 'not a uri')).toBe('ephemeral');
  });

  it('falls through when resolvedMongoUri is undefined (worker never resolved one, e.g. setup() bailed early)', () => {
    expect(classifyPortClass({ host: '127.0.0.1', port: 54321 }, undefined)).toBe('ephemeral');
  });
});

// ---------------------------------------------------------------------------
// classifyOpContext — operationKind precedence (AC-2/AC-3)
// ---------------------------------------------------------------------------

describe('classifyOpContext', () => {
  const resolvedMongoUri = 'mongodb://localhost:27018/crowi_test_1_abcd?maxPoolSize=10';

  it('classifies a Supertest ephemeral-port ETIMEDOUT as pre-dispatch, httpStatus null, dispatched false — the class this feature was built to capture', () => {
    const result = classifyOpContext({
      errorMessages: ['connect ETIMEDOUT 127.0.0.1:54321'],
      recentOps: [],
      testFullName: 'PageHandler returns 200',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'pre-dispatch', httpStatus: null, dispatched: false, portClass: 'ephemeral' });
  });

  it('classifies an ETIMEDOUT against the resolved Mongo host:port as a unit-level failure, NOT pre-dispatch', () => {
    const result = classifyOpContext({
      errorMessages: ['connect ETIMEDOUT 127.0.0.1:27018'],
      recentOps: [],
      testFullName: 'PageHandler returns 200',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'unit', httpStatus: null, portClass: 'mongo' });
  });

  it('uses the ring buffer\'s last matching op for this test as an "http" operationKind when there is no connection-failure evidence', () => {
    const result = classifyOpContext({
      errorMessages: ['expect(received).toBe(expected)'],
      recentOps: [
        { method: 'GET', path: '/api/pages', httpStatus: 200, testFullName: 'PageHandler returns 200' },
        { method: 'GET', path: '/api/pages/1', httpStatus: 404, testFullName: 'PageHandler returns 200' },
      ],
      testFullName: 'PageHandler returns 200',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'http', httpStatus: 404, httpMethod: 'GET', httpPath: '/api/pages/1', dispatched: true });
  });

  it('ignores ring-buffer entries belonging to a DIFFERENT test (parallel-request isolation)', () => {
    const result = classifyOpContext({
      errorMessages: ['expect(received).toBe(expected)'],
      recentOps: [{ method: 'GET', path: '/api/pages', httpStatus: 200, testFullName: 'SomeOtherTest' }],
      testFullName: 'PageHandler returns 200',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'unit', httpStatus: null });
  });

  it('classifies a direct Mongoose failure with no HTTP involvement (no connection evidence, no matching op) as "unit"', () => {
    const result = classifyOpContext({
      errorMessages: ['E11000 duplicate key error collection: crowi_test.pages index: path_1'],
      recentOps: [],
      testFullName: 'PageModel createPage',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'unit', httpStatus: null, portClass: null });
  });

  it('falls back to "unclassified" for a connection failure against neither Mongo nor a loopback host, with no matching op', () => {
    const result = classifyOpContext({
      errorMessages: ['connect ECONNREFUSED example.invalid:443'],
      recentOps: [],
      testFullName: 'SomeExternalCallTest',
      resolvedMongoUri,
    });
    expect(result.operationKind).toBe('unclassified');
  });

  it('a dispatched-but-statusless ring buffer entry (app threw before responding) still reports httpStatus: null, but as "http" (dispatched), distinct from pre-dispatch', () => {
    const result = classifyOpContext({
      errorMessages: ['TypeError: Cannot read properties of undefined'],
      recentOps: [{ method: 'POST', path: '/api/pages', httpStatus: null, testFullName: 'PageHandler creates a page' }],
      testFullName: 'PageHandler creates a page',
      resolvedMongoUri,
    });
    expect(result).toMatchObject({ operationKind: 'http', httpStatus: null, dispatched: true });
  });
});

// ---------------------------------------------------------------------------
// testFullNameFromCircusNode
// ---------------------------------------------------------------------------

describe('testFullNameFromCircusNode', () => {
  it('returns null for a nullish/non-object node', () => {
    expect(testFullNameFromCircusNode(null)).toBeNull();
    expect(testFullNameFromCircusNode(undefined)).toBeNull();
  });

  it("joins ancestor describe-block names + the test name with a single space, excluding ROOT_DESCRIBE_BLOCK — matches jest-circus's getTestID/currentTestName format", () => {
    const root = { name: 'ROOT_DESCRIBE_BLOCK', parent: undefined };
    const outer = { name: 'PageHandler', parent: root };
    const inner = { name: 'GET /pages/:id', parent: outer };
    const test = { name: 'returns 404 for a missing page', parent: inner };
    expect(testFullNameFromCircusNode(test)).toBe('PageHandler GET /pages/:id returns 404 for a missing page');
  });

  it("returns the describe block's own name chain when given a describeBlock instead of a test (beforeAll has no single test)", () => {
    const root = { name: 'ROOT_DESCRIBE_BLOCK', parent: undefined };
    const describeBlock = { name: 'PageHandler', parent: root };
    expect(testFullNameFromCircusNode(describeBlock)).toBe('PageHandler');
  });
});

// ---------------------------------------------------------------------------
// buildWorkerEnrichmentRecord (pure) + handleTestEvent (real class instance)
// ---------------------------------------------------------------------------

describe('buildWorkerEnrichmentRecord', () => {
  const root = { name: 'ROOT_DESCRIBE_BLOCK', parent: undefined };
  const describeBlock = { name: 'PageHandler', parent: root };
  const test = { name: 'returns 200', parent: describeBlock };
  const baseContext = { mongoUri: 'mongodb://localhost:27018/crowi_test_1?maxPoolSize=10', testFilePath: 'src/hono/handlers/page.test.ts', ringBuffer: [] };

  it('returns null for an event this taxonomy does not enrich', () => {
    expect(buildWorkerEnrichmentRecord({ name: 'test_start', test }, {}, baseContext)).toBeNull();
  });

  it('builds a "test" phase record from test_fn_failure', () => {
    const record = buildWorkerEnrichmentRecord({ name: 'test_fn_failure', test, error: new Error('expect(received).toBe(expected)') }, {}, baseContext);
    expect(record).toMatchObject({
      kind: 'worker-enrichment',
      testFilePath: 'src/hono/handlers/page.test.ts',
      testFullName: 'PageHandler returns 200',
      phase: 'test',
      errorName: 'Error',
      errorMessage: 'expect(received).toBe(expected)',
    });
  });

  it('builds a "hook:beforeEach" phase record from hook_failure when a test is present', () => {
    const record = buildWorkerEnrichmentRecord(
      { name: 'hook_failure', test, describeBlock, error: new Error('boom'), hook: { type: 'beforeEach' } },
      {},
      baseContext,
    );
    expect(record).toMatchObject({ phase: 'hook:beforeEach', testFullName: 'PageHandler returns 200' });
  });

  it('builds a "hook:beforeAll" phase record from hook_failure with no single test — falls back to the describe block\'s name', () => {
    const record = buildWorkerEnrichmentRecord(
      { name: 'hook_failure', test: undefined, describeBlock, error: new Error('boom'), hook: { type: 'beforeAll' } },
      {},
      baseContext,
    );
    expect(record).toMatchObject({ phase: 'hook:beforeAll', testFullName: 'PageHandler' });
  });

  it('builds an "unhandled" phase record from an error event, using state.currentlyRunningTest for identity', () => {
    const record = buildWorkerEnrichmentRecord({ name: 'error', error: new Error('stray') }, { currentlyRunningTest: test }, baseContext);
    expect(record).toMatchObject({ phase: 'unhandled', testFullName: 'PageHandler returns 200' });
  });

  it('normalizes a non-Error thrown value instead of crashing', () => {
    const record = buildWorkerEnrichmentRecord({ name: 'test_fn_failure', test, error: 'a string was thrown' }, {}, baseContext);
    expect(record).toMatchObject({ errorName: 'UnknownError', errorMessage: 'a string was thrown' });
  });

  it('truncates a very long error message', () => {
    const record = buildWorkerEnrichmentRecord({ name: 'test_fn_failure', test, error: new Error('x'.repeat(5000)) }, {}, baseContext);
    expect((record?.errorMessage as string).length).toBeLessThanOrEqual(2000);
  });
});

describe('handleTestEvent (real CrowiEnvironment method, isolated instance)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const failureTaxonomyChannel = require('./failure-taxonomy-channel') as {
    RUN_ID_ENV_VAR: string;
    readChannel: (runId: string) => { records: Array<Record<string, unknown>> };
    cleanupChannel: (runId: string) => void;
  };

  const originalRunIdEnv = process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR];

  afterEach(() => {
    if (originalRunIdEnv === undefined) delete process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR];
    else process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR] = originalRunIdEnv;
  });

  /** Builds a `CrowiEnvironment` instance WITHOUT running the real constructor (which needs a full jest-environment-node context) — just enough state for `handleTestEvent` to read (`this.mongoUri` / `this.testFilePath` / `this.global`). */
  function fakeEnvironmentInstance(overrides: Record<string, unknown> = {}) {
    const instance = Object.create(CrowiEnvironment.prototype);
    instance.mongoUri = 'mongodb://localhost:27018/crowi_test_1?maxPoolSize=10';
    instance.testFilePath = 'src/hono/handlers/page.test.ts';
    instance.global = { [RING_BUFFER_GLOBAL_KEY]: [] };
    Object.assign(instance, overrides);
    return instance;
  }

  it('appends a worker-enrichment record to the channel for a real test_fn_failure event', async () => {
    process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR] = `crowi-environment-handleTestEvent-test-${randomBytes(4).toString('hex')}`;
    const runId = process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR] as string;
    const instance = fakeEnvironmentInstance();

    try {
      const root = { name: 'ROOT_DESCRIBE_BLOCK', parent: undefined };
      const describeBlock = { name: 'PageHandler', parent: root };
      const test = { name: 'returns 200', parent: describeBlock };

      await instance.handleTestEvent({ name: 'test_fn_failure', test, error: new Error('boom') }, {});

      const { records } = failureTaxonomyChannel.readChannel(runId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: 'worker-enrichment', testFilePath: 'src/hono/handlers/page.test.ts', phase: 'test', errorMessage: 'boom' });
    } finally {
      failureTaxonomyChannel.cleanupChannel(runId);
    }
  });

  it('is a no-op for an event this taxonomy does not enrich (e.g. test_start) — no record appended', async () => {
    process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR] = `crowi-environment-handleTestEvent-test-${randomBytes(4).toString('hex')}`;
    const runId = process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR] as string;
    const instance = fakeEnvironmentInstance();

    await instance.handleTestEvent({ name: 'test_start', test: {} }, {});
    const { existed } = failureTaxonomyChannel.readChannel(runId);
    expect(existed).toBe(false);
  });

  it('fails open (does not throw) when CROWI_FAILURE_TAXONOMY_RUN_ID is unset — a broken/unconfigured harness must not break the real test run', async () => {
    delete process.env[failureTaxonomyChannel.RUN_ID_ENV_VAR];
    const instance = fakeEnvironmentInstance();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        instance.handleTestEvent({ name: 'test_fn_failure', test: { name: 'x', parent: undefined }, error: new Error('boom') }, {}),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('handleTestEvent enrichment failed'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('RING_BUFFER_GLOBAL_KEY / op-ring-buffer.ts GLOBAL_KEY drift guard', () => {
  it("stays in sync with op-ring-buffer.ts's exported GLOBAL_KEY (see op-ring-buffer.ts's doc comment — the two literals cannot share an import across module systems, so this assertion is the only thing that would catch one being edited without the other)", () => {
    expect(RING_BUFFER_GLOBAL_KEY).toBe(RING_BUFFER_GLOBAL_KEY_FROM_OP_RING_BUFFER);
  });
});
