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

import { MONGO_URI } from './setup';

// `crowi-environment.js` / `test-mongo-sentinel.js` are plain CJS with no
// type declarations — required directly rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CrowiEnvironment = require('./crowi-environment');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSentinelPath } = require('./test-mongo-sentinel');

const { buildPerFileUri, resolvedExternalMongoUri, dropPerFileDatabase, assertMaxPoolSizeSpliced } = CrowiEnvironment.__test__ as {
  buildPerFileUri: (rawUri: string, dbName: string) => string;
  resolvedExternalMongoUri: () => string | undefined;
  dropPerFileDatabase: (mongoUri: string) => Promise<void>;
  assertMaxPoolSizeSpliced: (uri: string) => void;
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
