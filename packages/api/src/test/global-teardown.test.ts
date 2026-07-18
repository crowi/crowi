/**
 * Coverage for `global-teardown.js`'s feature-redis-8-upgrade Phase 2
 * addition: aggregating the 8 Redis smoke category markers and CI-gating
 * the run when fewer than 8 ran. jest `globalTeardown` runs ONCE, in the
 * main process, strictly after every worker finished — see that module's
 * doc comment for the race-free reasoning this relies on (mirrors
 * `test-mongo-sentinel.js`'s guarantee for `globalSetup`).
 *
 * Every test isolates its own `CROWI_TEST_RUN_ID` (same reasoning as
 * `global-setup.test.ts`): the REAL one is already set for this worker and
 * points at the ambient run's real marker files, which every other test
 * file / worker in this run may also be writing.
 */
import { randomUUID } from 'node:crypto';

// Plain CJS, no type declarations — required directly (same pattern as
// `global-setup.test.ts`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const globalTeardown = require('./global-teardown');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { REDIS_SMOKE_CATEGORIES, writeMarker, listMarkedCategories } = require('./redis-smoke-sentinel');

describe('globalTeardown — Redis smoke category coverage gate', () => {
  const originalRunId = process.env.CROWI_TEST_RUN_ID;
  const originalCi = process.env.CI;

  beforeEach(() => {
    process.env.CROWI_TEST_RUN_ID = `global-teardown-test-${randomUUID()}`;
  });

  afterEach(() => {
    if (originalRunId === undefined) delete process.env.CROWI_TEST_RUN_ID;
    else process.env.CROWI_TEST_RUN_ID = originalRunId;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  it('CI + all 8 categories marked: does not throw, and cleans up every marker it wrote', async () => {
    process.env.CI = 'true';
    for (const category of REDIS_SMOKE_CATEGORIES) {
      writeMarker(category);
    }

    await expect(globalTeardown()).resolves.toBeUndefined();

    // Cleaned up — a later `listMarkedCategories()` call for the SAME run
    // id sees nothing left behind.
    expect(listMarkedCategories()).toEqual([]);
  });

  it('CI + fewer than 8 categories marked: throws, naming the missing categories, but still cleans up the markers it wrote', async () => {
    process.env.CI = 'true';
    writeMarker('collab');
    writeMarker('editor-cap');
    writeMarker('presence');
    // notifications / config / rate-limit / lru / boot never ran.

    await expect(globalTeardown()).rejects.toThrow(/ran 3\/8/);

    expect(listMarkedCategories()).toEqual([]);
  });

  it('CI + zero categories marked: throws', async () => {
    process.env.CI = 'true';

    await expect(globalTeardown()).rejects.toThrow(/0\/8/);
  });

  it('non-CI + zero categories marked: does not throw (local dev without docker compose up -d)', async () => {
    delete process.env.CI;

    await expect(globalTeardown()).resolves.toBeUndefined();
  });

  it('non-CI + a partial set of categories marked: does not throw, and still cleans up', async () => {
    delete process.env.CI;
    writeMarker('boot');

    await expect(globalTeardown()).resolves.toBeUndefined();
    expect(listMarkedCategories()).toEqual([]);
  });
});
